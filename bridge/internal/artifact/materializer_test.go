package artifact

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"

	"agentroom.dev/bridge/internal/config"
	"agentroom.dev/bridge/internal/pairing"
	contracts "agentroom.dev/contracts/generated/go"
)

type downloadServer struct {
	server      *httptest.Server
	source      []byte
	sha256      string
	mu          sync.Mutex
	ranges      []string
	corrupt     bool
	unavailable bool
	artifactID  string
	contentID   string
	alias       string
}

func newDownloadServer(t *testing.T, source []byte) *downloadServer {
	t.Helper()
	digest := sha256.Sum256(source)
	download := &downloadServer{
		source: source, sha256: hex.EncodeToString(digest[:]),
		artifactID: "artifact_materialize_12345678",
		contentID:  "content_materialize_12345678",
	}
	download.alias = "artifact://" + download.artifactID + "/result.patch"
	download.server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("authorization") != "Bearer device-secret" ||
			request.Header.Get(config.ServerTokenHeader) != "central-secret" {
			http.Error(writer, "unauthorized", http.StatusUnauthorized)
			return
		}
		expectedPath := fmt.Sprintf(
			"/api/bridge/runs/run_materialize_12345678/artifacts/%s/contents/%s",
			download.artifactID,
			download.contentID,
		)
		if request.URL.Path != expectedPath {
			http.NotFound(writer, request)
			return
		}
		if download.unavailable {
			http.Error(writer, "temporarily unavailable", http.StatusServiceUnavailable)
			return
		}
		rangeValue := request.Header.Get("range")
		download.mu.Lock()
		download.ranges = append(download.ranges, rangeValue)
		download.mu.Unlock()
		parts := strings.Split(strings.TrimPrefix(rangeValue, "bytes="), "-")
		if len(parts) != 2 {
			http.Error(writer, "range", http.StatusRequestedRangeNotSatisfiable)
			return
		}
		start, startErr := strconv.Atoi(parts[0])
		end, endErr := strconv.Atoi(parts[1])
		if startErr != nil || endErr != nil || start < 0 || end < start || end >= len(source) {
			http.Error(writer, "range", http.StatusRequestedRangeNotSatisfiable)
			return
		}
		chunk := append([]byte(nil), source[start:end+1]...)
		if download.corrupt && len(chunk) > 0 {
			chunk[0] ^= 0xff
		}
		writer.Header().Set("content-type", "text/x-diff")
		writer.Header().Set("content-range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(source)))
		writer.Header().Set("x-agentroom-content-id", download.contentID)
		writer.Header().Set("x-agentroom-content-sha256", download.sha256)
		writer.Header().Set("x-agentroom-logical-alias", download.alias)
		writer.WriteHeader(http.StatusPartialContent)
		_, _ = writer.Write(chunk)
	}))
	t.Cleanup(download.server.Close)
	return download
}

func (d *downloadServer) request() contracts.RunRequestedPayload {
	return contracts.RunRequestedPayload{
		RunID: "run_materialize_12345678", TargetAgentID: "agent_materialize_12345678",
		ContextPlan: &contracts.RuntimeContextPlan{
			ResultEvidence: &contracts.TaskResultEvidence{
				ArtifactRefs: []contracts.ArtifactReference{{
					ArtifactID: d.artifactID, Type: contracts.Patch,
					Content: &contracts.PinnedArtifactContent{
						ContentID: d.contentID, LogicalAlias: d.alias,
						MediaType: contracts.TextXDiff, Sha256: d.sha256,
						SizeBytes: int64(len(d.source)),
					},
				}},
			},
		},
	}
}

func (d *downloadServer) manager(t *testing.T, dataDir, workspace string) *Materializer {
	t.Helper()
	return NewMaterializer(config.Config{
		ServerURL: d.server.URL, ServerToken: "central-secret", DataDir: dataDir,
		Agents: []config.AgentConfig{{Name: "Builder", Workspace: workspace}},
	}, pairing.Credential{Token: "device-secret"}, map[string]string{
		"Builder": "agent_materialize_12345678",
	})
}

func TestMaterializerStagesVerifiedReadOnlyContentAndReusesReceipt(t *testing.T) {
	source := []byte("diff --git a/a.go b/a.go\n" + strings.Repeat("+verified\n", 40_000))
	download := newDownloadServer(t, source)
	dataDir := t.TempDir()
	workspace := t.TempDir()
	manager := download.manager(t, dataDir, workspace)
	receipts, err := manager.Materialize(context.Background(), download.request())
	if err != nil {
		t.Fatal(err)
	}
	if len(receipts) != 1 || receipts[0].MaterializationState != contracts.Verified ||
		receipts[0].LogicalAlias != download.alias {
		t.Fatalf("unexpected receipt: %#v", receipts)
	}
	finalPath := filepath.Join(
		dataDir, "materializations", "run_materialize_12345678",
		download.artifactID, "result.patch",
	)
	staged, err := os.ReadFile(finalPath)
	if err != nil || string(staged) != string(source) {
		t.Fatalf("staged content mismatch: bytes=%d err=%v", len(staged), err)
	}
	info, err := os.Lstat(finalPath)
	if err != nil || info.Mode().Perm() != 0o400 || info.Mode()&0o111 != 0 {
		t.Fatalf("staged mode=%v err=%v", info.Mode(), err)
	}
	entries, err := os.ReadDir(workspace)
	if err != nil || len(entries) != 0 {
		t.Fatalf("configured Workspace was mutated: entries=%v err=%v", entries, err)
	}
	aliases, err := manager.RuntimeArtifacts(download.request())
	resolvedFinalPath, resolveErr := filepath.EvalSymlinks(finalPath)
	if err != nil || len(aliases) != 1 || aliases[0].ArtifactID != download.artifactID ||
		aliases[0].ContentID != download.contentID || aliases[0].LogicalAlias != download.alias ||
		resolveErr != nil || aliases[0].LocalPath != resolvedFinalPath ||
		aliases[0].SHA256 != download.sha256 ||
		aliases[0].SizeBytes != int64(len(source)) || aliases[0].MediaType != contracts.TextXDiff {
		t.Fatalf("Runtime aliases=%#v err=%v", aliases, err)
	}
	download.mu.Lock()
	firstRequestCount := len(download.ranges)
	download.mu.Unlock()
	secondManager := download.manager(t, dataDir, workspace)
	reused, err := secondManager.Materialize(context.Background(), download.request())
	if err != nil || len(reused) != 1 || reused[0].MaterializationState != contracts.Reused {
		t.Fatalf("reused receipt=%#v err=%v", reused, err)
	}
	download.mu.Lock()
	defer download.mu.Unlock()
	if len(download.ranges) != firstRequestCount {
		t.Fatalf("receipt reuse downloaded again: before=%d after=%d", firstRequestCount, len(download.ranges))
	}
}

func TestRuntimeArtifactAdmissionRevalidatesStagedBytesAndPermissions(t *testing.T) {
	download := newDownloadServer(t, []byte("verified Runtime input"))
	dataDir := t.TempDir()
	manager := download.manager(t, dataDir, t.TempDir())
	request := download.request()
	if _, err := manager.Materialize(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	finalPath := filepath.Join(
		dataDir, "materializations", request.RunID, download.artifactID, "result.patch",
	)
	if err := os.Chmod(finalPath, 0o600); err != nil {
		t.Fatal(err)
	}
	if aliases, err := manager.RuntimeArtifacts(request); err == nil || aliases != nil ||
		!strings.Contains(err.Error(), "staged_content_permissions_changed") {
		t.Fatalf("changed permissions aliases=%#v err=%v", aliases, err)
	}
	if err := os.WriteFile(finalPath, []byte("tampered Runtime input"), 0o400); err != nil {
		t.Fatal(err)
	}
	if aliases, err := manager.RuntimeArtifacts(request); err == nil || aliases != nil ||
		!strings.Contains(err.Error(), "staged_digest_mismatch") {
		t.Fatalf("tampered bytes aliases=%#v err=%v", aliases, err)
	}
}

func TestMaterializerResumesPartialDownloadAfterRestart(t *testing.T) {
	source := []byte(strings.Repeat("0123456789abcdef", 45_000))
	download := newDownloadServer(t, source)
	dataDir := t.TempDir()
	workspace := t.TempDir()
	artifactDirectory := filepath.Join(
		dataDir, "materializations", "run_materialize_12345678", download.artifactID,
	)
	if err := os.MkdirAll(artifactDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	partialPath := filepath.Join(artifactDirectory, "."+download.contentID+".part")
	const offset = 123_457
	if err := os.WriteFile(partialPath, source[:offset], 0o600); err != nil {
		t.Fatal(err)
	}
	receipts, err := download.manager(t, dataDir, workspace).Materialize(
		context.Background(),
		download.request(),
	)
	if err != nil || len(receipts) != 1 || receipts[0].MaterializationState != contracts.Verified {
		t.Fatalf("resume receipt=%#v err=%v", receipts, err)
	}
	download.mu.Lock()
	defer download.mu.Unlock()
	if len(download.ranges) == 0 || !strings.HasPrefix(download.ranges[0], "bytes=123457-") {
		t.Fatalf("download did not resume from partial offset: %v", download.ranges)
	}
}

func TestMaterializerRejectsDigestFailureAndWorkspaceOverlap(t *testing.T) {
	download := newDownloadServer(t, []byte("verified source"))
	download.corrupt = true
	dataDir := t.TempDir()
	workspace := t.TempDir()
	_, err := download.manager(t, dataDir, workspace).Materialize(
		context.Background(),
		download.request(),
	)
	if err == nil || IsRetryableMaterialization(err) ||
		!strings.Contains(err.Error(), "staged_digest_mismatch") {
		t.Fatalf("digest failure=%v", err)
	}
	finalPath := filepath.Join(
		dataDir, "materializations", "run_materialize_12345678",
		download.artifactID, "result.patch",
	)
	if _, statErr := os.Lstat(finalPath); !os.IsNotExist(statErr) {
		t.Fatalf("digest mismatch installed final content: %v", statErr)
	}

	workspaceData := filepath.Join(workspace, ".agentroom-data")
	if err := os.Mkdir(workspaceData, 0o700); err != nil {
		t.Fatal(err)
	}
	_, overlapErr := download.manager(t, workspaceData, workspace).Materialize(
		context.Background(),
		download.request(),
	)
	if overlapErr == nil || !strings.Contains(overlapErr.Error(), "staging_overlaps_workspace") {
		t.Fatalf("Workspace overlap error=%v", overlapErr)
	}
	if _, statErr := os.Lstat(filepath.Join(workspaceData, "materializations")); !os.IsNotExist(statErr) {
		t.Fatalf("Workspace-overlapping staging was created: %v", statErr)
	}
}

func TestMaterializerRejectsUnsafeStagingLinksAndIdentifiers(t *testing.T) {
	download := newDownloadServer(t, []byte("verified source"))
	dataDir := t.TempDir()
	workspace := t.TempDir()
	invalid := download.request()
	invalid.ContextPlan.ResultEvidence.ArtifactRefs[0].ArtifactID = "artifact_short"
	if _, err := download.manager(t, dataDir, workspace).Materialize(
		context.Background(),
		invalid,
	); err == nil || !strings.Contains(err.Error(), "invalid_artifact_descriptor") {
		t.Fatalf("invalid identifier error=%v", err)
	}
	if runtime.GOOS == "windows" {
		t.Skip("symbolic-link setup requires platform privileges on Windows")
	}
	runDirectory := filepath.Join(dataDir, "materializations", "run_materialize_12345678")
	if err := os.MkdirAll(runDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	link := filepath.Join(runDirectory, download.artifactID)
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	if _, err := download.manager(t, dataDir, workspace).Materialize(
		context.Background(),
		download.request(),
	); err == nil || !strings.Contains(err.Error(), "unsafe_artifact_staging") {
		t.Fatalf("symlink staging error=%v", err)
	}
	entries, err := os.ReadDir(outside)
	if err != nil || len(entries) != 0 {
		t.Fatalf("symlink target was mutated: entries=%v err=%v", entries, err)
	}
}

func TestMaterializerClassifiesUnavailableDownloadAsRetryable(t *testing.T) {
	download := newDownloadServer(t, []byte("verified source"))
	download.unavailable = true
	_, err := download.manager(t, t.TempDir(), t.TempDir()).Materialize(
		context.Background(),
		download.request(),
	)
	if err == nil || !IsRetryableMaterialization(err) ||
		!strings.Contains(err.Error(), "download_rejected_503") {
		t.Fatalf("unavailable download error=%v", err)
	}
}

func TestMaterializerRejectsNonRegularPartialFile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix-domain socket fixture is not portable to Windows")
	}
	download := newDownloadServer(t, []byte("verified source"))
	dataDir, err := os.MkdirTemp("/tmp", "agentroom-materializer-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dataDir) })
	artifactDirectory := filepath.Join(
		dataDir,
		"materializations",
		"run_materialize_12345678",
		download.artifactID,
	)
	if err := os.MkdirAll(artifactDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	partialPath := filepath.Join(artifactDirectory, "."+download.contentID+".part")
	socketPath := filepath.Join(dataDir, "s")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if err := os.Rename(socketPath, partialPath); err != nil {
		t.Fatal(err)
	}
	_, err = download.manager(t, dataDir, t.TempDir()).Materialize(
		context.Background(),
		download.request(),
	)
	if err == nil || !strings.Contains(err.Error(), "unsafe_staging_file") {
		t.Fatalf("non-regular staging error=%v", err)
	}
}

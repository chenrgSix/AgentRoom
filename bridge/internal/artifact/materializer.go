package artifact

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	stdruntime "runtime"
	"strconv"
	"strings"
	"sync"

	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/pairing"
	bridgeruntime "convenewire.dev/bridge/internal/runtime"
	contracts "convenewire.dev/contracts/generated/go"
)

const materializationChunkBytes = 256 << 10

var materializationIdentifier = regexp.MustCompile(`^[A-Za-z0-9_-]{8,128}$`)

type MaterializationError struct {
	Code      string
	Retryable bool
}

func (e MaterializationError) Error() string {
	return "Artifact materialization failed: " + e.Code
}

func IsRetryableMaterialization(err error) bool {
	var failure MaterializationError
	return errors.As(err, &failure) && failure.Retryable
}

type Materializer struct {
	config             config.Config
	credential         pairing.Credential
	httpClient         *http.Client
	workspaceByAgentID map[string]string
	mu                 sync.Mutex
	runLocks           map[string]*materializationRunLock
}

type materializationRunLock struct {
	mu         sync.Mutex
	references int
}

type materializationReceiptFile struct {
	ArtifactID   string              `json:"artifactId"`
	ContentID    string              `json:"contentId"`
	LogicalAlias string              `json:"logicalAlias"`
	MediaType    contracts.MediaType `json:"mediaType"`
	SHA256       string              `json:"sha256"`
	SizeBytes    int64               `json:"sizeBytes"`
}

type materializationTarget struct {
	ArtifactID string
	Content    contracts.PinnedArtifactContent
}

func NewMaterializer(
	cfg config.Config,
	credential pairing.Credential,
	agentIdentities map[string]string,
) *Materializer {
	workspaces := make(map[string]string, len(cfg.Agents))
	for _, agent := range cfg.Agents {
		if agentID := agentIdentities[agent.Name]; agentID != "" {
			workspaces[agentID] = agent.Workspace
		}
	}
	return &Materializer{
		config: cfg, credential: credential, httpClient: pairing.HTTPClientForCredential(cfg, credential),
		workspaceByAgentID: workspaces,
		runLocks:           make(map[string]*materializationRunLock),
	}
}

func (m *Materializer) Materialize(
	ctx context.Context,
	request contracts.RunRequestedPayload,
) ([]contracts.VerifiedArtifactMaterializationReceipt, error) {
	if !validMaterializationID(request.RunID, "run_") ||
		!validMaterializationID(request.TargetAgentID, "agent_") {
		return nil, materializationFailure("invalid_run_descriptor", false)
	}
	targets, err := materializationTargets(request)
	if err != nil || len(targets) == 0 {
		return nil, err
	}
	release := m.acquireRun(request.RunID)
	defer release()
	root, err := m.isolatedRoot(request.TargetAgentID)
	if err != nil {
		return nil, err
	}
	if err := ensurePrivateDirectory(root); err != nil {
		return nil, materializationFailure("unsafe_staging_root", false)
	}
	runDirectory, err := ensureChildDirectory(root, request.RunID)
	if err != nil {
		return nil, materializationFailure("unsafe_run_staging", false)
	}
	receipts := make([]contracts.VerifiedArtifactMaterializationReceipt, 0, len(targets))
	for _, target := range targets {
		receipt, err := m.materializeOne(ctx, request.RunID, runDirectory, target)
		if err != nil {
			return nil, err
		}
		receipts = append(receipts, receipt)
	}
	return receipts, nil
}

// RuntimeArtifacts revalidates installed files and local receipts immediately
// before Runtime admission. It is the only boundary that reveals local staging
// paths, and those paths remain inside the Bridge process and Runtime prompt.
func (m *Materializer) RuntimeArtifacts(
	request contracts.RunRequestedPayload,
) ([]bridgeruntime.VerifiedArtifactAlias, error) {
	if !validMaterializationID(request.RunID, "run_") ||
		!validMaterializationID(request.TargetAgentID, "agent_") {
		return nil, materializationFailure("invalid_run_descriptor", false)
	}
	targets, err := materializationTargets(request)
	if err != nil || len(targets) == 0 {
		return nil, err
	}
	release := m.acquireRun(request.RunID)
	defer release()
	root, err := m.isolatedRoot(request.TargetAgentID)
	if err != nil {
		return nil, err
	}
	runDirectory := filepath.Join(root, request.RunID)
	aliases := make([]bridgeruntime.VerifiedArtifactAlias, 0, len(targets))
	for _, target := range targets {
		artifactDirectory := filepath.Join(runDirectory, target.ArtifactID)
		fileName := strings.TrimPrefix(
			target.Content.LogicalAlias,
			"artifact://"+target.ArtifactID+"/",
		)
		finalPath := filepath.Join(artifactDirectory, fileName)
		receiptPath := filepath.Join(artifactDirectory, ".receipt.json")
		receipt, ok, err := reusableMaterialization(
			finalPath,
			receiptPath,
			receiptFile(target),
		)
		if err != nil {
			return nil, err
		}
		if !ok || len([]byte(finalPath)) > bridgeruntime.MaximumArtifactPathBytes {
			return nil, materializationFailure("verified_alias_unavailable", false)
		}
		aliases = append(aliases, bridgeruntime.VerifiedArtifactAlias{
			ArtifactID: receipt.ArtifactID, ContentID: receipt.ContentID,
			LogicalAlias: receipt.LogicalAlias, LocalPath: finalPath,
			MediaType: receipt.MediaType, SHA256: receipt.SHA256,
			SizeBytes: receipt.SizeBytes,
		})
	}
	return aliases, nil
}

func (m *Materializer) materializeOne(
	ctx context.Context,
	runID string,
	runDirectory string,
	target materializationTarget,
) (contracts.VerifiedArtifactMaterializationReceipt, error) {
	artifactDirectory, err := ensureChildDirectory(runDirectory, target.ArtifactID)
	if err != nil {
		return contracts.VerifiedArtifactMaterializationReceipt{},
			materializationFailure("unsafe_artifact_staging", false)
	}
	fileName := strings.TrimPrefix(
		target.Content.LogicalAlias,
		"artifact://"+target.ArtifactID+"/",
	)
	finalPath := filepath.Join(artifactDirectory, fileName)
	partialPath := filepath.Join(artifactDirectory, "."+target.Content.ContentID+".part")
	receiptPath := filepath.Join(artifactDirectory, ".receipt.json")
	expected := receiptFile(target)
	if receipt, ok, err := reusableMaterialization(
		finalPath,
		receiptPath,
		expected,
	); err != nil {
		return contracts.VerifiedArtifactMaterializationReceipt{}, err
	} else if ok {
		return contractReceipt(receipt, contracts.Reused), nil
	}
	if exists, err := regularFileExists(finalPath); err != nil {
		return contracts.VerifiedArtifactMaterializationReceipt{}, err
	} else if exists {
		if err := verifyFile(finalPath, expected.SHA256, expected.SizeBytes); err != nil {
			return contracts.VerifiedArtifactMaterializationReceipt{}, err
		}
		if err := os.Chmod(finalPath, 0o400); err != nil {
			return contracts.VerifiedArtifactMaterializationReceipt{},
				materializationFailure("protect_staged_content", false)
		}
		if err := writeReceipt(receiptPath, expected); err != nil {
			return contracts.VerifiedArtifactMaterializationReceipt{}, err
		}
		return contractReceipt(expected, contracts.Reused), nil
	}
	offset, err := partialOffset(partialPath, target.Content.SizeBytes)
	if err != nil {
		return contracts.VerifiedArtifactMaterializationReceipt{}, err
	}
	for offset < target.Content.SizeBytes {
		end := min(offset+materializationChunkBytes, target.Content.SizeBytes) - 1
		chunk, err := m.downloadChunk(ctx, runID, target, offset, end)
		if err != nil {
			return contracts.VerifiedArtifactMaterializationReceipt{}, err
		}
		if err := appendMaterialization(partialPath, offset, chunk); err != nil {
			return contracts.VerifiedArtifactMaterializationReceipt{}, err
		}
		offset += int64(len(chunk))
	}
	if err := verifyFile(partialPath, target.Content.Sha256, target.Content.SizeBytes); err != nil {
		_ = os.Remove(partialPath)
		return contracts.VerifiedArtifactMaterializationReceipt{}, err
	}
	if err := os.Chmod(partialPath, 0o400); err != nil {
		return contracts.VerifiedArtifactMaterializationReceipt{},
			materializationFailure("protect_staged_content", false)
	}
	if err := os.Rename(partialPath, finalPath); err != nil {
		return contracts.VerifiedArtifactMaterializationReceipt{},
			materializationFailure("install_staged_content", false)
	}
	if err := syncDirectory(artifactDirectory); err != nil {
		return contracts.VerifiedArtifactMaterializationReceipt{}, err
	}
	if err := writeReceipt(receiptPath, expected); err != nil {
		return contracts.VerifiedArtifactMaterializationReceipt{}, err
	}
	return contractReceipt(expected, contracts.Verified), nil
}

func (m *Materializer) downloadChunk(
	ctx context.Context,
	runID string,
	target materializationTarget,
	start int64,
	end int64,
) ([]byte, error) {
	requestPath := fmt.Sprintf(
		"/api/bridge/runs/%s/artifacts/%s/contents/%s",
		runID,
		target.ArtifactID,
		target.Content.ContentID,
	)
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		strings.TrimRight(m.config.ServerURL, "/")+requestPath,
		nil,
	)
	if err != nil {
		return nil, materializationFailure("build_download_request", false)
	}
	request.Header.Set("authorization", "Bearer "+m.credential.Token)
	request.Header.Set("range", fmt.Sprintf("bytes=%d-%d", start, end))
	if m.config.ServerToken != "" {
		request.Header.Set(config.ServerTokenHeader, m.config.ServerToken)
	}
	response, err := m.httpClient.Do(request)
	if err != nil {
		return nil, materializationFailure("download_unavailable", true)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusPartialContent {
		return nil, materializationFailure(
			"download_rejected_"+strconv.Itoa(response.StatusCode),
			response.StatusCode >= 500,
		)
	}
	expectedRange := fmt.Sprintf(
		"bytes %d-%d/%d",
		start,
		end,
		target.Content.SizeBytes,
	)
	if response.Header.Get("content-range") != expectedRange ||
		response.Header.Get("x-agentroom-content-id") != target.Content.ContentID ||
		response.Header.Get("x-agentroom-content-sha256") != target.Content.Sha256 ||
		response.Header.Get("x-agentroom-logical-alias") != target.Content.LogicalAlias ||
		strings.Split(response.Header.Get("content-type"), ";")[0] !=
			string(target.Content.MediaType) {
		return nil, materializationFailure("download_metadata_mismatch", false)
	}
	expectedLength := end - start + 1
	source, err := io.ReadAll(io.LimitReader(response.Body, expectedLength+1))
	if err != nil {
		return nil, materializationFailure("download_interrupted", true)
	}
	if int64(len(source)) != expectedLength {
		return nil, materializationFailure("download_length_mismatch", false)
	}
	return source, nil
}

func (m *Materializer) isolatedRoot(agentID string) (string, error) {
	workspaceRoot := m.workspaceByAgentID[agentID]
	if workspaceRoot == "" {
		return "", materializationFailure("target_workspace_missing", false)
	}
	workspace, err := filepath.EvalSymlinks(workspaceRoot)
	if err != nil {
		return "", materializationFailure("target_workspace_invalid", false)
	}
	dataRoot, err := filepath.EvalSymlinks(m.config.DataDir)
	if err != nil {
		return "", materializationFailure("staging_root_invalid", false)
	}
	root := filepath.Join(dataRoot, "materializations")
	relative, err := filepath.Rel(workspace, root)
	if err != nil || relative == "." ||
		(relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))) {
		return "", materializationFailure("staging_overlaps_workspace", false)
	}
	return root, nil
}

func (m *Materializer) acquireRun(runID string) func() {
	m.mu.Lock()
	lock := m.runLocks[runID]
	if lock == nil {
		lock = &materializationRunLock{}
		m.runLocks[runID] = lock
	}
	lock.references++
	m.mu.Unlock()
	lock.mu.Lock()
	return func() {
		lock.mu.Unlock()
		m.mu.Lock()
		lock.references--
		if lock.references == 0 {
			delete(m.runLocks, runID)
		}
		m.mu.Unlock()
	}
}

func materializationTargets(
	request contracts.RunRequestedPayload,
) ([]materializationTarget, error) {
	if request.ContextPlan == nil || request.ContextPlan.ResultEvidence == nil {
		return nil, nil
	}
	references := request.ContextPlan.ResultEvidence.ArtifactRefs
	if len(references) > 20 {
		return nil, materializationFailure("too_many_artifacts", false)
	}
	targets := make([]materializationTarget, 0, len(references))
	identities := make(map[string]bool)
	aliases := make(map[string]bool)
	for _, reference := range references {
		if reference.Content == nil {
			continue
		}
		content := *reference.Content
		prefix := "artifact://" + reference.ArtifactID + "/"
		fileName := strings.TrimPrefix(content.LogicalAlias, prefix)
		if !strings.HasPrefix(content.LogicalAlias, prefix) || !safeFileName(fileName) ||
			content.SizeBytes < 1 || content.SizeBytes > MaximumSourceBytes ||
			!validLowerHex(content.Sha256, 64) ||
			!validMaterializationID(content.ContentID, "content_") ||
			!validMaterializationID(reference.ArtifactID, "artifact_") ||
			identities[reference.ArtifactID] || identities[content.ContentID] ||
			aliases[content.LogicalAlias] {
			return nil, materializationFailure("invalid_artifact_descriptor", false)
		}
		expectedMediaType, err := mediaTypeFor(string(reference.Type), fileName)
		if err != nil || expectedMediaType != string(content.MediaType) {
			return nil, materializationFailure("invalid_artifact_descriptor", false)
		}
		identities[reference.ArtifactID] = true
		identities[content.ContentID] = true
		aliases[content.LogicalAlias] = true
		targets = append(targets, materializationTarget{
			ArtifactID: reference.ArtifactID,
			Content:    content,
		})
	}
	return targets, nil
}

func ensurePrivateDirectory(path string) error {
	if err := os.Mkdir(path, 0o700); err != nil && !os.IsExist(err) {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return fmt.Errorf("unsafe directory")
	}
	return os.Chmod(path, 0o700)
}

func ensureChildDirectory(parent string, name string) (string, error) {
	if strings.ContainsAny(name, "/\\") || name == "" || name == "." || name == ".." {
		return "", fmt.Errorf("unsafe directory name")
	}
	if info, err := os.Lstat(parent); err != nil ||
		info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return "", fmt.Errorf("unsafe parent directory")
	}
	target := filepath.Join(parent, name)
	if err := ensurePrivateDirectory(target); err != nil {
		return "", err
	}
	return target, nil
}

func regularFileExists(path string) (bool, error) {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return false, materializationFailure("unsafe_staging_file", false)
	}
	return true, nil
}

func partialOffset(path string, maximum int64) (int64, error) {
	exists, err := regularFileExists(path)
	if err != nil || !exists {
		return 0, err
	}
	info, err := os.Lstat(path)
	if err != nil || info.Size() < 0 || info.Size() > maximum ||
		info.Mode().Perm() != 0o600 {
		return 0, materializationFailure("invalid_partial_content", false)
	}
	return info.Size(), nil
}

func appendMaterialization(path string, expectedOffset int64, source []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE, 0o600)
	if err != nil {
		return materializationFailure("open_partial_content", false)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() != expectedOffset {
		return materializationFailure("partial_offset_changed", false)
	}
	written, err := file.WriteAt(source, expectedOffset)
	if err != nil || written != len(source) {
		return materializationFailure("write_partial_content", false)
	}
	if err := file.Sync(); err != nil {
		return materializationFailure("sync_partial_content", false)
	}
	return nil
}

func verifyFile(path string, expectedSHA256 string, expectedSize int64) error {
	file, err := os.Open(path)
	if err != nil {
		return materializationFailure("open_staged_content", false)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() != expectedSize {
		return materializationFailure("staged_size_mismatch", false)
	}
	digest := sha256.New()
	count, err := io.Copy(digest, io.LimitReader(file, expectedSize+1))
	if err != nil || count != expectedSize ||
		hex.EncodeToString(digest.Sum(nil)) != expectedSHA256 {
		return materializationFailure("staged_digest_mismatch", false)
	}
	return nil
}

func reusableMaterialization(
	finalPath string,
	receiptPath string,
	expected materializationReceiptFile,
) (materializationReceiptFile, bool, error) {
	receiptExists, err := regularFileExists(receiptPath)
	if err != nil || !receiptExists {
		return materializationReceiptFile{}, false, err
	}
	finalExists, err := regularFileExists(finalPath)
	if err != nil || !finalExists {
		return materializationReceiptFile{}, false,
			materializationFailure("receipt_without_staged_content", false)
	}
	source, err := os.ReadFile(receiptPath)
	if err != nil {
		return materializationReceiptFile{}, false,
			materializationFailure("read_materialization_receipt", false)
	}
	decoder := json.NewDecoder(strings.NewReader(string(source)))
	decoder.DisallowUnknownFields()
	var receipt materializationReceiptFile
	if err := decoder.Decode(&receipt); err != nil || receipt != expected {
		return materializationReceiptFile{}, false,
			materializationFailure("materialization_receipt_mismatch", false)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return materializationReceiptFile{}, false,
			materializationFailure("materialization_receipt_mismatch", false)
	}
	if err := verifyFile(finalPath, expected.SHA256, expected.SizeBytes); err != nil {
		return materializationReceiptFile{}, false, err
	}
	finalInfo, finalErr := os.Lstat(finalPath)
	receiptInfo, receiptErr := os.Lstat(receiptPath)
	if finalErr != nil || receiptErr != nil || finalInfo.Mode().Perm() != 0o400 ||
		receiptInfo.Mode().Perm() != 0o600 {
		return materializationReceiptFile{}, false,
			materializationFailure("staged_content_permissions_changed", false)
	}
	return receipt, true, nil
}

func writeReceipt(path string, receipt materializationReceiptFile) error {
	source, err := json.MarshalIndent(receipt, "", "  ")
	if err != nil {
		return materializationFailure("encode_materialization_receipt", false)
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".receipt-*")
	if err != nil {
		return materializationFailure("create_materialization_receipt", false)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return materializationFailure("protect_materialization_receipt", false)
	}
	if _, err := temporary.Write(append(source, '\n')); err != nil {
		temporary.Close()
		return materializationFailure("write_materialization_receipt", false)
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return materializationFailure("sync_materialization_receipt", false)
	}
	if err := temporary.Close(); err != nil {
		return materializationFailure("close_materialization_receipt", false)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return materializationFailure("install_materialization_receipt", false)
	}
	return syncDirectory(filepath.Dir(path))
}

func syncDirectory(path string) error {
	if stdruntime.GOOS == "windows" {
		return nil
	}
	directory, err := os.Open(path)
	if err != nil {
		return materializationFailure("open_staging_directory", false)
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return materializationFailure("sync_staging_directory", false)
	}
	return nil
}

func validMaterializationID(value string, prefix string) bool {
	return strings.HasPrefix(value, prefix) &&
		materializationIdentifier.MatchString(strings.TrimPrefix(value, prefix))
}

func receiptFile(target materializationTarget) materializationReceiptFile {
	return materializationReceiptFile{
		ArtifactID: target.ArtifactID, ContentID: target.Content.ContentID,
		LogicalAlias: target.Content.LogicalAlias, MediaType: target.Content.MediaType,
		SHA256: target.Content.Sha256, SizeBytes: target.Content.SizeBytes,
	}
}

func contractReceipt(
	receipt materializationReceiptFile,
	state contracts.MaterializationState,
) contracts.VerifiedArtifactMaterializationReceipt {
	return contracts.VerifiedArtifactMaterializationReceipt{
		ArtifactID: receipt.ArtifactID, ContentID: receipt.ContentID,
		LogicalAlias: receipt.LogicalAlias, MaterializationState: state,
		MediaType: receipt.MediaType, Sha256: receipt.SHA256,
		SizeBytes: receipt.SizeBytes,
	}
}

func materializationFailure(code string, retryable bool) error {
	return MaterializationError{Code: code, Retryable: retryable}
}

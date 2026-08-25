package artifact

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"agentroom.dev/bridge/internal/config"
	"agentroom.dev/bridge/internal/pairing"
)

func TestPublisherRecoversLostResponsesWithoutSendingLocalPaths(t *testing.T) {
	const (
		deviceToken   = "device-secret-token"
		serverToken   = "central-server-token"
		publicationID = "publication_12345678"
		contentID     = "content_12345678"
		artifactID    = "artifact_12345678"
	)
	localPath := testWorkspace(t)
	sourceBytes := []byte("diff --git a/a b/a\n+verified\n")
	if err := os.WriteFile(filepath.Join(localPath, "change.patch"), sourceBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	sourcePlan, err := PlanSource(localPath, "change.patch", "patch")
	if err != nil {
		t.Fatal(err)
	}
	var mutex sync.Mutex
	state := "prepared"
	received := 0
	leaseCalls := 0
	prepareCalls := 0
	chunkCalls := 0
	bindCalls := 0
	requestBodies := make([]string, 0)
	writePublication := func(writer http.ResponseWriter) {
		response := map[string]any{
			"publicationId": publicationID,
			"receivedSize":  received,
			"state":         state,
			"contentId":     nil,
			"artifactId":    nil,
		}
		if state == "sealed" || state == "bound" {
			response["contentId"] = contentID
		}
		if state == "bound" {
			response["artifactId"] = artifactID
		}
		_ = json.NewEncoder(writer).Encode(response)
	}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		mutex.Lock()
		defer mutex.Unlock()
		if request.Header.Get("Authorization") != "Bearer "+deviceToken ||
			request.Header.Get(config.ServerTokenHeader) != serverToken {
			t.Errorf("missing Artifact API credentials")
			writer.WriteHeader(http.StatusUnauthorized)
			return
		}
		var body map[string]any
		if request.Body != nil {
			_ = json.NewDecoder(request.Body).Decode(&body)
			encoded, _ := json.Marshal(body)
			requestBodies = append(requestBodies, string(encoded))
		}
		switch {
		case request.URL.Path == "/api/bridge/workspace-leases/read-source":
			leaseCalls++
			if leaseCalls == 1 {
				closeResponse(t, writer)
				return
			}
			_ = json.NewEncoder(writer).Encode(map[string]string{
				"leaseId": "lease_12345678", "state": "active",
			})
		case request.URL.Path == "/api/bridge/artifact-publications" && request.Method == http.MethodPost:
			prepareCalls++
			if body["fileName"] != "change.patch" {
				t.Errorf("unsafe or missing file name: %#v", body["fileName"])
			}
			relations, ok := body["relations"].([]any)
			if !ok || len(relations) != 1 ||
				relations[0].(map[string]any)["type"] != "derives_from" ||
				relations[0].(map[string]any)["targetArtifactId"] != "artifact_source_12345678" {
				t.Errorf("missing canonical Artifact lineage: %#v", body["relations"])
			}
			if prepareCalls == 1 {
				closeResponse(t, writer)
				return
			}
			writePublication(writer)
		case strings.HasSuffix(request.URL.Path, "/chunks"):
			chunkCalls++
			decoded, err := base64.StdEncoding.DecodeString(body["chunkBase64"].(string))
			if err != nil {
				t.Error(err)
			}
			received += len(decoded)
			state = "receiving"
			if chunkCalls == 1 {
				closeResponse(t, writer)
				return
			}
			writePublication(writer)
		case strings.HasSuffix(request.URL.Path, "/seal"):
			state = "sealed"
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"publication": map[string]any{
					"publicationId": publicationID, "receivedSize": received,
					"state": state, "contentId": contentID,
				},
				"content": map[string]string{"contentId": contentID},
			})
		case strings.HasSuffix(request.URL.Path, "/bind"):
			bindCalls++
			state = "bound"
			closeResponse(t, writer)
		case request.URL.Path == "/api/bridge/artifact-publications/"+publicationID:
			writePublication(writer)
		default:
			writer.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	client := NewClient(config.Config{
		ServerURL: server.URL, ServerToken: serverToken,
	}, pairing.Credential{Token: deviceToken})
	input := PublishInput{
		RunID: "run_12345678", AgentID: "agent_12345678",
		ArtifactType: "patch", Title: "Verified patch", Summary: "Safe summary",
		Source: sourcePlan,
		Relations: []PublishRelation{{
			Type: "derives_from", TargetArtifactID: "artifact_source_12345678",
		}},
	}
	result, err := client.Publish(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if result.ArtifactID != artifactID || result.ContentID != contentID ||
		result.PublicationID != publicationID {
		t.Fatalf("unexpected publish result: %#v", result)
	}
	second, err := client.Publish(context.Background(), input)
	if err != nil || second.ArtifactID != artifactID {
		t.Fatalf("exact retry did not converge: result=%#v err=%v", second, err)
	}
	if leaseCalls != 3 || prepareCalls != 3 || chunkCalls != 1 || bindCalls != 1 {
		t.Fatalf(
			"unexpected recovery calls: lease=%d prepare=%d chunk=%d bind=%d",
			leaseCalls, prepareCalls, chunkCalls, bindCalls,
		)
	}
	for _, body := range requestBodies {
		if strings.Contains(body, localPath) {
			t.Fatalf("request exposed a local path: %s", body)
		}
	}
}

func TestPublisherDoesNotReadSourceBeforeLeaseAcceptance(t *testing.T) {
	root := testWorkspace(t)
	target := filepath.Join(root, "denied.patch")
	if err := os.WriteFile(target, []byte("diff --git a/a b/a\n+denied\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	plan, err := PlanSource(root, "denied.patch", "patch")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(target); err != nil {
		t.Fatal(err)
	}
	leaseCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		leaseCalls++
		writer.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"error": map[string]string{"message": "Workspace lease denied"},
		})
	}))
	defer server.Close()

	client := NewClient(config.Config{ServerURL: server.URL}, pairing.Credential{
		Token: "device-secret-token",
	})
	_, err = client.Publish(context.Background(), PublishInput{
		RunID: "run_12345678", AgentID: "agent_12345678",
		ArtifactType: "patch", Title: "Denied", Summary: "Denied by active scope.",
		Source: plan,
	})
	if err == nil || !strings.Contains(err.Error(), "Workspace lease denied") {
		t.Fatalf("lease denial error = %v", err)
	}
	if leaseCalls != 1 {
		t.Fatalf("lease calls = %d, want 1", leaseCalls)
	}
}

func TestPublisherUsesDistinctRenewableLeaseIdentityForNewArtifacts(t *testing.T) {
	root := testWorkspace(t)
	if err := os.Mkdir(filepath.Join(root, "results"), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"first.patch", "second.patch"} {
		if err := os.WriteFile(
			filepath.Join(root, "results", name),
			[]byte("diff --git a/a b/a\n+"+name+"\n"),
			0o600,
		); err != nil {
			t.Fatal(err)
		}
	}
	first, err := PlanSource(root, "results/first.patch", "patch")
	if err != nil {
		t.Fatal(err)
	}
	second, err := PlanSource(root, "results/second.patch", "patch")
	if err != nil {
		t.Fatal(err)
	}
	if first.WorkspaceGeneration != second.WorkspaceGeneration {
		t.Fatal("test sources did not share one Workspace generation")
	}
	base := PublishInput{
		RunID: "run_12345678", AgentID: "agent_12345678",
		ArtifactType: "patch", Title: "Result", Summary: "One result.",
		Source: first,
	}
	firstKey := leaseIdempotencyKey(base, nil)
	if leaseIdempotencyKey(base, nil) != firstKey {
		t.Fatal("exact lease attempt identity drifted")
	}
	base.Source = second
	if leaseIdempotencyKey(base, nil) == firstKey {
		t.Fatal("new Artifact source reused the prior lease attempt identity")
	}
}

func TestPublisherNormalizesAndRejectsInvalidRelations(t *testing.T) {
	relations, err := normalizedPublishRelations([]PublishRelation{{
		Type: "verifies", TargetArtifactID: "artifact_z_source_12345678",
	}, {
		Type: "derives_from", TargetArtifactID: "artifact_a_source_12345678",
	}})
	if err != nil || len(relations) != 2 || relations[0].Type != "derives_from" {
		t.Fatalf("relations=%#v err=%v", relations, err)
	}
	if _, err := normalizedPublishRelations([]PublishRelation{{
		Type: "invalid", TargetArtifactID: "artifact_source_12345678",
	}}); err == nil {
		t.Fatal("invalid Artifact relation type was accepted")
	}
	duplicate := PublishRelation{
		Type: "reviews", TargetArtifactID: "artifact_source_12345678",
	}
	if _, err := normalizedPublishRelations([]PublishRelation{
		duplicate, duplicate,
	}); err == nil {
		t.Fatal("duplicate Artifact relation was accepted")
	}
}

func closeResponse(t *testing.T, writer http.ResponseWriter) {
	t.Helper()
	hijacker, ok := writer.(http.Hijacker)
	if !ok {
		t.Fatal("test server does not support response hijacking")
	}
	connection, _, err := hijacker.Hijack()
	if err != nil {
		t.Fatal(err)
	}
	_ = connection.Close()
}

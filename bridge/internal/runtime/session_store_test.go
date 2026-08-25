package runtime

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"agentroom.dev/bridge/internal/config"
	contracts "agentroom.dev/contracts/generated/go"
)

func TestFileRuntimeSessionStorePersistsTaskScopedBinding(t *testing.T) {
	dataDir := t.TempDir()
	workspace := t.TempDir()
	store := NewFileRuntimeSessionStore(dataDir)
	key := testRuntimeSessionKey(t, config.AgentConfig{
		RuntimeKind: "codex", Adapter: "codex", Workspace: workspace,
		Command: []string{"codex", "app-server"}, Sandbox: "workspace-write",
	}, "task_alpha")
	if _, found, err := store.Load(key); err != nil || found {
		t.Fatalf("unexpected empty session lookup: found=%t err=%v", found, err)
	}
	if err := store.Save(RuntimeSessionBinding{
		RuntimeSessionKey:      key,
		SessionID:              "thread_alpha",
		LastRoomSequence:       42,
		RoomMemoryRevision:     3,
		TaskMemoryRevision:     4,
		ResultEvidenceRevision: 5,
		LastRunID:              "run_alpha",
	}); err != nil {
		t.Fatal(err)
	}
	binding, found, err := store.Load(key)
	if err != nil || !found || binding.SessionID != "thread_alpha" ||
		binding.LastRoomSequence != 42 || binding.LastRunID != "run_alpha" ||
		binding.RoomMemoryRevision != 3 || binding.TaskMemoryRevision != 4 ||
		binding.ResultEvidenceRevision != 5 ||
		binding.CreatedAt.IsZero() || binding.UpdatedAt.IsZero() {
		t.Fatalf("unexpected persisted session: %#v found=%t err=%v", binding, found, err)
	}
	path, err := store.bindingPath(key)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("Runtime session binding permissions are %o", info.Mode().Perm())
	}
	directoryInfo, err := os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if directoryInfo.Mode().Perm() != 0o700 {
		t.Fatalf("Runtime session directory permissions are %o", directoryInfo.Mode().Perm())
	}
	source, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(source), workspace) {
		t.Fatal("raw workspace path leaked into Runtime session binding")
	}
	other := key
	other.TaskID = "task_beta"
	if _, found, err := store.Load(other); err != nil || found {
		t.Fatalf("Runtime session crossed Task scope: found=%t err=%v", found, err)
	}
	if err := store.Delete(key); err != nil {
		t.Fatal(err)
	}
	if _, found, err := store.Load(key); err != nil || found {
		t.Fatalf("deleted session remained visible: found=%t err=%v", found, err)
	}
}

func TestTaskSessionContextKeepsOnlyUnconsumedMemoryRevisions(t *testing.T) {
	sequence41 := int64(41)
	sequence43 := int64(43)
	run := contracts.RunRequestedPayload{
		ContextMessages: []contracts.ContextMessage{
			{MessageID: "msg_old_12345678", Sequence: &sequence41, Content: "old"},
			{MessageID: "msg_new_12345678", Sequence: &sequence43, Content: "new"},
		},
		ContextPlan: &contracts.RuntimeContextPlan{
			RoomMemory: &contracts.RoomMemoryClass{
				Revision: 3, SourceCursor: 30, Summary: "Room revision three",
			},
			TaskMemory: &contracts.TaskMemoryClass{
				Revision: 5, SourceCursor: 31, Summary: "Task revision five",
			},
			ResultEvidence: &contracts.TaskResultEvidence{
				Revision: 2,
				ArtifactRefs: []contracts.ArtifactReference{{
					ArtifactID: "artifact_delta_12345678", Type: contracts.Commit,
					Title: "Delta", Summary: "Verify the commit",
				}},
			},
		},
	}
	delta := contextDeltaForSession(run, RuntimeSessionBinding{
		LastRoomSequence: 42, RoomMemoryRevision: 3, TaskMemoryRevision: 4,
		ResultEvidenceRevision: 1,
	})
	if len(delta.ContextMessages) != 1 ||
		delta.ContextMessages[0].MessageID != "msg_new_12345678" {
		t.Fatalf("Room delta was not filtered: %#v", delta.ContextMessages)
	}
	if delta.ContextPlan == nil || delta.ContextPlan.RoomMemory != nil ||
		delta.ContextPlan.TaskMemory == nil ||
		delta.ContextPlan.TaskMemory.Revision != 5 ||
		delta.ContextPlan.ResultEvidence == nil ||
		delta.ContextPlan.ResultEvidence.Revision != 2 {
		t.Fatalf("memory revision delta was not filtered: %#v", delta.ContextPlan)
	}
}

func TestRuntimeSessionKeyRollsOnWorkspaceAndSemanticConfig(t *testing.T) {
	configuration := config.AgentConfig{
		RuntimeKind: "codex", Adapter: "codex", Workspace: t.TempDir(),
		Command: []string{"codex", "app-server"}, Sandbox: "workspace-write",
		EnvAllowlist: []string{"PATH", "LANG"},
	}
	baseline := testRuntimeSessionKey(t, configuration, "task_alpha")
	reordered := configuration
	reordered.EnvAllowlist = []string{"LANG", "PATH"}
	if candidate := testRuntimeSessionKey(t, reordered, "task_alpha"); candidate != baseline {
		t.Fatal("equivalent environment allowlist order changed the session key")
	}
	changedConfig := configuration
	changedConfig.Sandbox = "read-only"
	if candidate := testRuntimeSessionKey(t, changedConfig, "task_alpha"); candidate == baseline {
		t.Fatal("semantic Runtime configuration change reused the session key")
	}
	changedWorkspace := configuration
	changedWorkspace.Workspace = t.TempDir()
	if candidate := testRuntimeSessionKey(t, changedWorkspace, "task_alpha"); candidate == baseline {
		t.Fatal("workspace change reused the session key")
	}
}

func TestLegacyRoomSessionNeverAliasesTaskScopedSession(t *testing.T) {
	configuration := config.AgentConfig{
		RuntimeKind: "codex", Adapter: "codex", Workspace: t.TempDir(),
		Command: []string{"codex", "app-server"},
	}
	legacy, eligible, err := planRuntimeSession(
		"codex",
		configuration,
		contracts.RunRequestedPayload{
			RoomID: "room_alpha", TargetAgentID: "agent_builder",
		},
	)
	if err != nil || !eligible || legacy.LogicalTask || legacy.Key.TaskID != legacyRoomTaskScope {
		t.Fatalf("legacy Room request was not isolated safely: %#v err=%v", legacy, err)
	}
	task := testRuntimeSessionKey(t, configuration, "task_alpha")
	if legacy.Key == task {
		t.Fatal("Task-scoped request fell back to a legacy Room session key")
	}
}

func TestFileRuntimeSessionStoreRejectsTamperedBinding(t *testing.T) {
	store := NewFileRuntimeSessionStore(t.TempDir())
	key := testRuntimeSessionKey(t, config.AgentConfig{
		RuntimeKind: "codex", Adapter: "codex", Workspace: t.TempDir(),
		Command: []string{"codex", "app-server"},
	}, "task_alpha")
	path, err := store.bindingPath(key)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	tamperedKey := key
	tamperedKey.RoomID = "room_other"
	source, err := json.Marshal(RuntimeSessionBinding{
		RuntimeSessionKey: tamperedKey,
		SessionID:         "thread_wrong",
		CreatedAt:         time.Now().UTC(),
		UpdatedAt:         time.Now().UTC(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, source, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Load(key); err == nil {
		t.Fatal("tampered Runtime session binding was accepted")
	}
}

func testRuntimeSessionKey(
	t *testing.T,
	configuration config.AgentConfig,
	taskID string,
) RuntimeSessionKey {
	t.Helper()
	request := contracts.RunRequestedPayload{
		RoomID:        "room_alpha",
		TargetAgentID: "agent_builder",
		TaskID:        &taskID,
		Session: &contracts.LogicalSessionRequest{
			Scope:         contracts.Task,
			ResumePolicy:  contracts.ResumeOrStart,
			ContextCursor: 42,
		},
	}
	plan, eligible, err := planRuntimeSession(configuration.RuntimeKind, configuration, request)
	if err != nil || !eligible {
		t.Fatalf("could not build Runtime session key: eligible=%t err=%v", eligible, err)
	}
	return plan.Key
}

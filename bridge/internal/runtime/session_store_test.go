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
		RuntimeSessionKey:          key,
		SessionID:                  "thread_alpha",
		LastRoomSequence:           42,
		RoomMemoryRevision:         3,
		TaskMemoryRevision:         4,
		RoomLongTermMemoryRevision: 6,
		TaskLongTermMemoryRevision: 7,
		ResultEvidenceRevision:     5,
		LastRunID:                  "run_alpha",
	}); err != nil {
		t.Fatal(err)
	}
	binding, found, err := store.Load(key)
	if err != nil || !found || binding.SessionID != "thread_alpha" ||
		binding.LastRoomSequence != 42 || binding.LastRunID != "run_alpha" ||
		binding.RoomMemoryRevision != 3 || binding.TaskMemoryRevision != 4 ||
		binding.RoomLongTermMemoryRevision != 6 ||
		binding.TaskLongTermMemoryRevision != 7 ||
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

func TestTaskSessionContextFiltersLongTermMemoryByScopeRevision(t *testing.T) {
	run := contracts.RunRequestedPayload{
		ContextPlan: &contracts.RuntimeContextPlan{
			LongTermMemory: &contracts.LongTermProvenanceMemoryPlan{
				Room: &contracts.RoomClass{
					Revision: 2, ActiveComplete: true,
					Entries: []contracts.RoomProvenanceMemoryEntry{{
						MemoryID: "memory_room_12345678", Type: contracts.Constraint,
						Content: "Keep compatibility", State: contracts.Active, Revision: 2,
						SourceMessageIDS: []string{"msg_room_memory_12345678"},
					}},
				},
				Task: &contracts.TaskClass{
					Revision: 3, ActiveComplete: true,
					Entries: []contracts.TaskProvenanceMemoryEntry{{
						MemoryID: "memory_task_12345678", Type: contracts.Goal,
						Content: "Complete migration", State: contracts.Active, Revision: 3,
						SourceMessageIDS: []string{"msg_task_memory_12345678"},
					}},
				},
			},
		},
	}
	delta := contextDeltaForSession(run, RuntimeSessionBinding{
		RoomLongTermMemoryRevision: 2,
		TaskLongTermMemoryRevision: 2,
	})
	if delta.ContextPlan == nil || delta.ContextPlan.LongTermMemory == nil ||
		delta.ContextPlan.LongTermMemory.Room != nil ||
		delta.ContextPlan.LongTermMemory.Task == nil {
		t.Fatalf("long-term Memory scope delta was not filtered: %#v", delta.ContextPlan)
	}
	roomRevision, taskRevision := longTermMemoryRevisions(delta)
	if roomRevision != 0 || taskRevision != 3 {
		t.Fatalf("unexpected long-term Memory revisions: %d %d", roomRevision, taskRevision)
	}
}

func TestTaskSessionContextKeepsOnlyUnconsumedMemoryRevisions(t *testing.T) {
	sequence41 := int64(41)
	sequence43 := int64(43)
	deliveryKind := contracts.Delta
	fromRevision := int64(1)
	throughRevision := int64(2)
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
				Revision: 2, DeliveryKind: &deliveryKind,
				FromRevision: &fromRevision, ThroughRevision: &throughRevision,
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

func TestTaskSessionContextRejectsResultEvidenceCursorGap(t *testing.T) {
	deliveryKind := contracts.Delta
	fromRevision := int64(4)
	throughRevision := int64(6)
	run := contracts.RunRequestedPayload{
		ContextPlan: &contracts.RuntimeContextPlan{
			ResultEvidence: &contracts.TaskResultEvidence{
				Revision: 6, DeliveryKind: &deliveryKind,
				FromRevision: &fromRevision, ThroughRevision: &throughRevision,
				ArtifactRefs: []contracts.ArtifactReference{{
					ArtifactID: "artifact_gap_12345678", Type: contracts.Commit,
					Title: "Gap", Summary: "Must not consume a discontinuous page",
				}},
			},
		},
	}
	binding := RuntimeSessionBinding{ResultEvidenceRevision: 3}
	if !hasResultEvidenceCursorGap(run, binding) {
		t.Fatal("discontinuous result evidence was not classified as a cursor gap")
	}
	delta := contextDeltaForSession(run, binding)
	if delta.ContextPlan != nil {
		t.Fatalf("discontinuous result evidence was accepted: %#v", delta.ContextPlan)
	}
	_, _, resultRevision := contextRevisions(delta)
	if resultRevision != 0 {
		t.Fatalf("discontinuous page advanced result evidence cursor: %d", resultRevision)
	}
	binding.ResultEvidenceRevision = 6
	if hasResultEvidenceCursorGap(run, binding) {
		t.Fatal("an already-consumed result evidence page was misclassified as a gap")
	}
}

func TestTaskSessionContextKeepsHistoricalProjectionWithoutAdvancingCanonicalRevision(t *testing.T) {
	historical := contracts.Historical
	run := contracts.RunRequestedPayload{
		ContextPlan: &contracts.RuntimeContextPlan{
			RoomMemory: &contracts.RoomMemoryClass{
				Revision: 8, SourceCursor: 20, Summary: "Historical room evidence",
				ProjectionKind: &historical,
			},
			TaskMemory: &contracts.TaskMemoryClass{
				Revision: 9, SourceCursor: 21, Summary: "Historical task evidence",
				ProjectionKind: &historical,
			},
		},
	}
	delta := contextDeltaForSession(run, RuntimeSessionBinding{
		RoomMemoryRevision: 8,
		TaskMemoryRevision: 9,
	})
	if delta.ContextPlan == nil || delta.ContextPlan.RoomMemory == nil ||
		delta.ContextPlan.TaskMemory == nil {
		t.Fatalf("historical projection was filtered as canonical: %#v", delta.ContextPlan)
	}
	roomRevision, taskRevision, _ := contextRevisions(delta)
	if roomRevision != 0 || taskRevision != 0 {
		t.Fatalf("historical projection advanced canonical revisions: %d %d", roomRevision, taskRevision)
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
	changedConflictPolicy := configuration
	changedConflictPolicy.CodexSessionConflictPolicy = config.CodexSessionConflictStartNew
	if candidate := testRuntimeSessionKey(t, changedConflictPolicy, "task_alpha"); candidate != baseline {
		t.Fatal("conflict handling policy bypassed the existing session instead of governing its resume")
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

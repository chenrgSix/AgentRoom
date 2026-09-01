package runtime

import (
	"strings"
	"testing"

	contracts "convenewire.dev/contracts/generated/go"
)

func TestRuntimePromptProjectsNamedContextAndExactRoutingAgents(t *testing.T) {
	targetName := "Builder"
	alice := "Alice"
	reviewer := "Reviewer"
	prompt := runtimePrompt(contracts.RunRequestedPayload{
		Instruction:      "Implement the queue fix.",
		TriggerMessageID: "msg_trigger_12345678",
		TargetAgentName:  &targetName,
		RoutingAgents: []contracts.RoutingAgent{
			{AgentID: "agent_reviewer_12345678", Name: "Reviewer"},
			{AgentID: "agent_qa_123456789012", Name: "QA Lead"},
		},
		ContextMessages: []contracts.ContextMessage{
			{
				MessageID: "msg_context_12345678", SenderID: "member_alice_12345678",
				SenderName: &alice, Content: "Keep delivery durable.",
			},
			{
				MessageID: "msg_context_23456789", SenderID: "agent_reviewer_12345678",
				SenderName: &reviewer, Content: "Use exact names.",
			},
			{
				MessageID: "msg_trigger_12345678", SenderID: "member_alice_12345678",
				SenderName: &alice, Content: "Implement the queue fix.",
			},
		},
	})
	for _, expected := range []string{
		"Your Agent name is Builder.",
		"Reviewer; QA Lead",
		"prefix one exact full name with @",
		"[Alice]: Keep delivery durable.",
		"[Reviewer]: Use exact names.",
		"Current request:\nImplement the queue fix.",
	} {
		if !strings.Contains(prompt, expected) {
			t.Fatalf("prompt omitted %q:\n%s", expected, prompt)
		}
	}
	if strings.Count(prompt, "Implement the queue fix.") != 1 {
		t.Fatalf("trigger was duplicated in context:\n%s", prompt)
	}
	if strings.Contains(prompt, "@Reviewer") || strings.Contains(prompt, "@all") {
		t.Fatalf("prompt template contained an executable mention command:\n%s", prompt)
	}
}

func TestRuntimePromptPreservesLegacyInstructionWithoutProjection(t *testing.T) {
	if prompt := runtimePrompt(contracts.RunRequestedPayload{Instruction: "  hello team  "}); prompt != "hello team" {
		t.Fatalf("unexpected legacy prompt: %q", prompt)
	}
}

func TestRuntimePromptProjectsFrozenContextManifest(t *testing.T) {
	maxDuration := int64(1200)
	prompt := runtimePrompt(contracts.RunRequestedPayload{
		Instruction: "Review the implementation.",
		ContextManifest: &contracts.ContextManifest{
			TaskRevision: 4, DefinitionRevision: 2, CriteriaRevision: 3,
			Goal: "Ship a bounded review.",
			Criteria: []contracts.Criterion{{
				CriterionKey: "criterion_review0001",
				Description:  "Focused tests pass.", Required: true, Ordinal: 1,
			}},
			Permissions: contracts.Permissions{
				FilesystemAccess:   contracts.PermissionsFilesystemAccess("workspace-write"),
				NetworkAccess:      contracts.NetworkAccess("not_recorded"),
				Interrupt:          contracts.Handoff("supported"),
				Handoff:            contracts.Handoff("unsupported"),
				MaxDurationSeconds: &maxDuration,
			},
			OmittedCategories: []contracts.OmittedCategory{
				contracts.ProviderCredentials,
				contracts.HiddenReasoning,
			},
		},
	})
	for _, expected := range []string{
		"Frozen Run contract (Task revision 4; definition revision 2; criteria revision 3)",
		"Task goal: Ship a bounded review.",
		"[required] criterion_review0001: Focused tests pass.",
		"filesystem=workspace-write; network=not_recorded; interrupt=supported; handoff=unsupported; max duration=1200 seconds",
		"provider_credentials, hidden_reasoning",
	} {
		if !strings.Contains(prompt, expected) {
			t.Fatalf("Context Manifest prompt omitted %q:\n%s", expected, prompt)
		}
	}
}

func TestRuntimePromptProjectsGovernedScopeWithoutGrantingAcceptanceAuthority(t *testing.T) {
	prompt := runtimePrompt(contracts.RunRequestedPayload{
		Instruction: "Implement the approved node.",
		ContextManifest: &contracts.ContextManifest{
			TaskRevision: 4, DefinitionRevision: 2, CriteriaRevision: 3,
			Goal:        "Ship a bounded change.",
			Permissions: contracts.Permissions{},
			Execution: &contracts.Execution{
				Scope: contracts.ScopeClass{PlanID: "plan_runtime0001", PlanRevision: 2,
					NodeKey: "Build", DispatchGeneration: 3},
				Repository: contracts.Repository{RepositoryID: "repo_runtime0001",
					BaseCommit: strings.Repeat("a", 40)},
				Workspace: contracts.Workspace{Mode: contracts.Mode("isolated_worktree")},
				ScopePolicy: contracts.ExecutionScopePolicy{Access: contracts.Access("isolated_write"),
					AllowedPaths: []string{"src", "tests"}, ForbiddenPaths: []string{"secrets"}},
				Outputs: []contracts.ExecutionOutput{{SlotKey: "patch", Kind: contracts.Kind("patch"), Required: true}},
				VerificationProfiles: []contracts.ExecutionVerificationProfile{{
					ProfileID: "profile_verify0001", Revision: 1, Required: true,
				}},
				Capture:  &contracts.CaptureClass{Outputs: []contracts.CaptureOutput{{SlotKey: "patch"}}},
				Deadline: "2026-09-01T11:00:00Z",
			},
		},
	})
	for _, expected := range []string{
		"approved plan plan_runtime0001 revision 2, node Build, dispatch generation 3",
		"repo_runtime0001 at base commit " + strings.Repeat("a", 40),
		"Allowed relative paths: src, tests.",
		"Forbidden relative paths: secrets.",
		"Declared outputs: patch:patch:required.",
		"profile_verify0001@1:required",
		"no independent verification or Result acceptance authority",
		"capture boundary will collect output slots: patch",
		"Do not claim that capture is review, verification, integration, or Task completion",
	} {
		if !strings.Contains(prompt, expected) {
			t.Fatalf("governed prompt omitted %q:\n%s", expected, prompt)
		}
	}
}

func TestRuntimePromptProjectsProvenancePreservingSharedMemory(t *testing.T) {
	commitSHA := "21f9e8c"
	deliveryKind := contracts.Delta
	fromRevision := int64(4)
	throughRevision := int64(5)
	artifactRevision := int64(5)
	prompt := runtimePrompt(contracts.RunRequestedPayload{
		Instruction: "Continue the migration.",
		ContextPlan: &contracts.RuntimeContextPlan{
			RoomMemory: &contracts.RoomMemoryClass{
				Revision: 2, SourceCursor: 20,
				SourceMessageIDS: []string{"msg_room_12345678"},
				Summary:          "Room: engineering\nKeep compatibility.",
			},
			TaskMemory: &contracts.TaskMemoryClass{
				Revision: 4, SourceCursor: 21,
				SourceMessageIDS: []string{"msg_task_12345678"},
				Summary:          "Task: OAuth migration\nState: working",
			},
			ResultEvidence: &contracts.TaskResultEvidence{
				Revision: 5, DeliveryKind: &deliveryKind,
				FromRevision: &fromRevision, ThroughRevision: &throughRevision,
				ArtifactRefs: []contracts.ArtifactReference{{
					ArtifactID: "artifact_commit_12345678", Type: contracts.TypeCommit,
					Title: "OAuth migration", Summary: "Focused tests passed.",
					CommitSHA: &commitSHA, ArtifactRevision: &artifactRevision,
					Relations: []contracts.ArtifactRelationReference{{
						RelationID:       "relation_verify_12345678",
						Type:             contracts.Verifies,
						TargetArtifactID: "artifact_source_12345678",
					}},
				}},
			},
		},
	})
	for _, expected := range []string{
		"Shared memory is a rebuildable projection",
		"Shared Room memory (revision 2; source cursor 20; evidence message IDs: msg_room_12345678)",
		"Shared Task memory (revision 4; source cursor 21; evidence message IDs: msg_task_12345678)",
		"Structured Task result evidence (delta revisions 5-5; references require local verification)",
		"revision 5; artifact_commit_12345678; commit",
		"commit=21f9e8c",
		"lineage=verifies:artifact_source_12345678",
		"Current request:\nContinue the migration.",
	} {
		if !strings.Contains(prompt, expected) {
			t.Fatalf("memory prompt omitted %q:\n%s", expected, prompt)
		}
	}
}

func TestRuntimePromptLabelsHistoricalMemoryAsRunLocal(t *testing.T) {
	historical := contracts.Historical
	prompt := runtimePrompt(contracts.RunRequestedPayload{
		Instruction: "Handle the delayed request.",
		ContextPlan: &contracts.RuntimeContextPlan{
			RoomMemory: &contracts.RoomMemoryClass{
				Revision: 5, SourceCursor: 10, Summary: "Older room evidence",
				ProjectionKind: &historical,
			},
		},
	})
	if !strings.Contains(prompt, "Historical Room context (run-local; canonical revision is not advanced)") {
		t.Fatalf("historical projection was not labeled safely:\n%s", prompt)
	}
}

func TestRuntimePromptProjectsLongTermMemoryWithLifecycleAndProvenance(t *testing.T) {
	supersedes := "memory_old_12345678"
	prompt := runtimePrompt(contracts.RunRequestedPayload{
		Instruction: "Continue the durable migration.",
		ContextPlan: &contracts.RuntimeContextPlan{
			LongTermMemory: &contracts.LongTermProvenanceMemoryPlan{
				Room: &contracts.RoomClass{
					Revision: 4, ActiveComplete: true,
					Entries: []contracts.RoomProvenanceMemoryEntry{{
						MemoryID: "memory_new_12345678", Type: contracts.Decision,
						Content: "Use PostgreSQL 18.", State: contracts.Active,
						Revision: 4, SupersedesMemoryID: &supersedes,
						SourceMessageIDS:  []string{"msg_decision_12345678"},
						SourceArtifactIDS: []string{"artifact_schema_12345678"},
					}},
				},
			},
		},
	})
	for _, expected := range []string{
		"Long-term Room provenance memory (scope revision 4; complete active snapshot)",
		"snapshot replaces prior memory state only where it is complete",
		"memory_new_12345678; decision; active; revision 4; supersedes=memory_old_12345678",
		"messages=msg_decision_12345678",
		"artifacts=artifact_schema_12345678",
	} {
		if !strings.Contains(prompt, expected) {
			t.Fatalf("long-term Memory prompt omitted %q:\n%s", expected, prompt)
		}
	}
}

func TestTaskSessionContextKeepsOnlyUnconsumedRoomDeltas(t *testing.T) {
	sequence41 := int64(41)
	sequence42 := int64(42)
	sequence43 := int64(43)
	messages := []contracts.ContextMessage{
		{MessageID: "msg_old_12345678", Sequence: &sequence41, Content: "already consumed"},
		{MessageID: "msg_boundary_12345678", Sequence: &sequence42, Content: "at cursor"},
		{MessageID: "msg_new_12345678", Sequence: &sequence43, Content: "new delta"},
		{MessageID: "msg_legacy_12345678", Content: "legacy without sequence"},
	}
	filtered := contextAfterCursor(messages, 42)
	if len(filtered) != 2 || filtered[0].MessageID != "msg_new_12345678" ||
		filtered[1].MessageID != "msg_legacy_12345678" {
		t.Fatalf("Task Session cursor repeated or skipped Room context: %#v", filtered)
	}
}

package runtime

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"agentroom.dev/bridge/internal/config"
	contracts "agentroom.dev/contracts/generated/go"
)

const legacyRoomTaskScope = "legacy-room"

type runtimeSessionPlan struct {
	Key           RuntimeSessionKey
	ScopeID       string
	LogicalTask   bool
	ContextCursor int64
	ResumePolicy  contracts.ResumePolicy
}

func planRuntimeSession(
	runtimeKind string,
	configuration config.AgentConfig,
	run contracts.RunRequestedPayload,
) (runtimeSessionPlan, bool, error) {
	if strings.TrimSpace(run.RoomID) == "" || strings.TrimSpace(run.TargetAgentID) == "" {
		return runtimeSessionPlan{}, false, nil
	}
	taskScope := legacyRoomTaskScope
	logicalTask := run.TaskID != nil && strings.TrimSpace(*run.TaskID) != "" &&
		run.Session != nil && run.Session.Scope == contracts.Task
	resumePolicy := contracts.ResumeOrStart
	contextCursor := int64(0)
	if logicalTask {
		taskScope = strings.TrimSpace(*run.TaskID)
		resumePolicy = run.Session.ResumePolicy
		contextCursor = run.Session.ContextCursor
		if contextCursor < 0 {
			return runtimeSessionPlan{}, false, fmt.Errorf("logical Task Session cursor cannot be negative")
		}
	}
	workspaceFingerprint, err := fingerprintWorkspace(configuration.Workspace)
	if err != nil {
		return runtimeSessionPlan{}, false, err
	}
	configFingerprint, err := fingerprintRuntimeConfig(configuration)
	if err != nil {
		return runtimeSessionPlan{}, false, err
	}
	scopeID, err := AgentRuntimeScopeID(configuration)
	if err != nil {
		return runtimeSessionPlan{}, false, err
	}
	if logicalTask && run.Session.RuntimeScopeID != nil &&
		*run.Session.RuntimeScopeID != scopeID {
		return runtimeSessionPlan{}, false, fmt.Errorf("logical Task Session scope does not match the published Runtime")
	}
	return runtimeSessionPlan{
		Key: RuntimeSessionKey{
			RuntimeKind:          runtimeKind,
			RoomID:               run.RoomID,
			TaskID:               taskScope,
			AgentID:              run.TargetAgentID,
			WorkspaceFingerprint: workspaceFingerprint,
			ConfigFingerprint:    configFingerprint,
			SchemaVersion:        runtimeSessionSchemaVersion,
		},
		ScopeID:       scopeID,
		LogicalTask:   logicalTask,
		ContextCursor: contextCursor,
		ResumePolicy:  resumePolicy,
	}, true, nil
}

// AgentRuntimeScopeID is safe to publish centrally. It changes when the local
// workspace or semantic Runtime configuration would create a different native
// Task Session, but it does not expose either value.
func AgentRuntimeScopeID(configuration config.AgentConfig) (string, error) {
	workspaceFingerprint, err := fingerprintWorkspace(configuration.Workspace)
	if err != nil {
		return "", err
	}
	configFingerprint, err := fingerprintRuntimeConfig(configuration)
	if err != nil {
		return "", err
	}
	encoded, err := json.Marshal(struct {
		RuntimeKind          string `json:"runtimeKind"`
		WorkspaceFingerprint string `json:"workspaceFingerprint"`
		ConfigFingerprint    string `json:"configFingerprint"`
		SchemaVersion        int    `json:"schemaVersion"`
	}{
		RuntimeKind:          configuration.RuntimeKind,
		WorkspaceFingerprint: workspaceFingerprint,
		ConfigFingerprint:    configFingerprint,
		SchemaVersion:        runtimeSessionSchemaVersion,
	})
	if err != nil {
		return "", fmt.Errorf("encode Runtime scope: %w", err)
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}

func fingerprintWorkspace(workspace string) (string, error) {
	resolved, err := filepath.Abs(filepath.Clean(workspace))
	if err != nil {
		return "", fmt.Errorf("resolve Runtime workspace: %w", err)
	}
	if canonical, canonicalErr := filepath.EvalSymlinks(resolved); canonicalErr == nil {
		resolved = canonical
	}
	return sha256Fingerprint([]byte(resolved)), nil
}

func fingerprintRuntimeConfig(configuration config.AgentConfig) (string, error) {
	envAllowlist := append([]string(nil), configuration.EnvAllowlist...)
	sort.Strings(envAllowlist)
	semantic := struct {
		Adapter        string   `json:"adapter"`
		RuntimeKind    string   `json:"runtimeKind"`
		PresetVersion  int      `json:"presetVersion"`
		Command        []string `json:"command"`
		Sandbox        string   `json:"sandbox"`
		OutputProtocol string   `json:"outputProtocol"`
		EnvAllowlist   []string `json:"envAllowlist"`
	}{
		Adapter:        configuration.Adapter,
		RuntimeKind:    configuration.RuntimeKind,
		PresetVersion:  configuration.PresetVersion,
		Command:        configuration.Command,
		Sandbox:        configuration.Sandbox,
		OutputProtocol: configuration.OutputProtocol,
		EnvAllowlist:   envAllowlist,
	}
	encoded, err := json.Marshal(semantic)
	if err != nil {
		return "", fmt.Errorf("encode Runtime session configuration: %w", err)
	}
	return sha256Fingerprint(encoded), nil
}

func sha256Fingerprint(source []byte) string {
	digest := sha256.Sum256(source)
	return "sha256:" + hex.EncodeToString(digest[:])
}

func contextAfterCursor(
	messages []contracts.ContextMessage,
	cursor int64,
) []contracts.ContextMessage {
	filtered := make([]contracts.ContextMessage, 0, len(messages))
	for _, message := range messages {
		if message.Sequence == nil || *message.Sequence > cursor {
			filtered = append(filtered, message)
		}
	}
	return filtered
}

func contextDeltaForSession(
	run contracts.RunRequestedPayload,
	binding RuntimeSessionBinding,
) contracts.RunRequestedPayload {
	run.ContextMessages = contextAfterCursor(
		run.ContextMessages,
		binding.LastRoomSequence,
	)
	if run.ContextPlan == nil {
		return run
	}
	plan := *run.ContextPlan
	if plan.RoomMemory != nil &&
		!isHistoricalProjection(plan.RoomMemory.ProjectionKind) &&
		plan.RoomMemory.Revision <= binding.RoomMemoryRevision {
		plan.RoomMemory = nil
	}
	if plan.TaskMemory != nil &&
		!isHistoricalProjection(plan.TaskMemory.ProjectionKind) &&
		plan.TaskMemory.Revision <= binding.TaskMemoryRevision {
		plan.TaskMemory = nil
	}
	if plan.LongTermMemory != nil {
		memory := *plan.LongTermMemory
		if memory.Room != nil &&
			memory.Room.Revision <= binding.RoomLongTermMemoryRevision {
			memory.Room = nil
		}
		if memory.Task != nil &&
			memory.Task.Revision <= binding.TaskLongTermMemoryRevision {
			memory.Task = nil
		}
		if memory.Room == nil && memory.Task == nil {
			plan.LongTermMemory = nil
		} else {
			plan.LongTermMemory = &memory
		}
	}
	if plan.ResultEvidence != nil {
		evidence := plan.ResultEvidence
		if evidence.DeliveryKind != nil && *evidence.DeliveryKind == contracts.Delta {
			if evidence.FromRevision == nil || evidence.ThroughRevision == nil ||
				*evidence.FromRevision != binding.ResultEvidenceRevision {
				plan.ResultEvidence = nil
			} else if *evidence.ThroughRevision <= binding.ResultEvidenceRevision {
				plan.ResultEvidence = nil
			}
		} else if evidence.Revision <= binding.ResultEvidenceRevision {
			plan.ResultEvidence = nil
		}
	}
	if plan.RoomMemory == nil && plan.TaskMemory == nil &&
		plan.ResultEvidence == nil && plan.LongTermMemory == nil {
		run.ContextPlan = nil
	} else {
		run.ContextPlan = &plan
	}
	return run
}

func longTermMemoryRevisions(
	run contracts.RunRequestedPayload,
) (int64, int64) {
	if run.ContextPlan == nil || run.ContextPlan.LongTermMemory == nil {
		return 0, 0
	}
	roomRevision := int64(0)
	if run.ContextPlan.LongTermMemory.Room != nil {
		roomRevision = run.ContextPlan.LongTermMemory.Room.Revision
	}
	taskRevision := int64(0)
	if run.ContextPlan.LongTermMemory.Task != nil {
		taskRevision = run.ContextPlan.LongTermMemory.Task.Revision
	}
	return roomRevision, taskRevision
}

func contextRevisions(
	run contracts.RunRequestedPayload,
) (int64, int64, int64) {
	if run.ContextPlan == nil {
		return 0, 0, 0
	}
	roomRevision := int64(0)
	if run.ContextPlan.RoomMemory != nil &&
		!isHistoricalProjection(run.ContextPlan.RoomMemory.ProjectionKind) {
		roomRevision = run.ContextPlan.RoomMemory.Revision
	}
	taskRevision := int64(0)
	if run.ContextPlan.TaskMemory != nil &&
		!isHistoricalProjection(run.ContextPlan.TaskMemory.ProjectionKind) {
		taskRevision = run.ContextPlan.TaskMemory.Revision
	}
	resultRevision := int64(0)
	if run.ContextPlan.ResultEvidence != nil {
		if run.ContextPlan.ResultEvidence.ThroughRevision != nil {
			resultRevision = *run.ContextPlan.ResultEvidence.ThroughRevision
		} else {
			resultRevision = run.ContextPlan.ResultEvidence.Revision
		}
	}
	return roomRevision, taskRevision, resultRevision
}

func isHistoricalProjection(kind *contracts.ProjectionKind) bool {
	return kind != nil && *kind == contracts.Historical
}

func sessionStatus(
	disposition contracts.Disposition,
	contextCursor int64,
	runtimeScopeID string,
	resultEvidenceRevision int64,
) *contracts.LogicalSessionStatus {
	return &contracts.LogicalSessionStatus{
		Disposition:            disposition,
		ContextCursor:          contextCursor,
		RuntimeScopeID:         &runtimeScopeID,
		ResultEvidenceRevision: &resultEvidenceRevision,
	}
}

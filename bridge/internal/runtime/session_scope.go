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
		LogicalTask:   logicalTask,
		ContextCursor: contextCursor,
		ResumePolicy:  resumePolicy,
	}, true, nil
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
		plan.RoomMemory.Revision <= binding.RoomMemoryRevision {
		plan.RoomMemory = nil
	}
	if plan.TaskMemory != nil &&
		plan.TaskMemory.Revision <= binding.TaskMemoryRevision {
		plan.TaskMemory = nil
	}
	if plan.ResultEvidence != nil &&
		plan.ResultEvidence.Revision <= binding.ResultEvidenceRevision {
		plan.ResultEvidence = nil
	}
	if plan.RoomMemory == nil && plan.TaskMemory == nil &&
		plan.ResultEvidence == nil {
		run.ContextPlan = nil
	} else {
		run.ContextPlan = &plan
	}
	return run
}

func contextRevisions(
	run contracts.RunRequestedPayload,
) (int64, int64, int64) {
	if run.ContextPlan == nil {
		return 0, 0, 0
	}
	roomRevision := int64(0)
	if run.ContextPlan.RoomMemory != nil {
		roomRevision = run.ContextPlan.RoomMemory.Revision
	}
	taskRevision := int64(0)
	if run.ContextPlan.TaskMemory != nil {
		taskRevision = run.ContextPlan.TaskMemory.Revision
	}
	resultRevision := int64(0)
	if run.ContextPlan.ResultEvidence != nil {
		resultRevision = run.ContextPlan.ResultEvidence.Revision
	}
	return roomRevision, taskRevision, resultRevision
}

func sessionStatus(
	disposition contracts.Disposition,
	contextCursor int64,
) *contracts.LogicalSessionStatus {
	return &contracts.LogicalSessionStatus{
		Disposition:   disposition,
		ContextCursor: contextCursor,
	}
}

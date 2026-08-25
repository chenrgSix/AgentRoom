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

func hasResultEvidenceCursorGap(
	run contracts.RunRequestedPayload,
	binding RuntimeSessionBinding,
) bool {
	if run.ContextPlan == nil || run.ContextPlan.ResultEvidence == nil {
		return false
	}
	evidence := run.ContextPlan.ResultEvidence
	if evidence.DeliveryKind == nil || *evidence.DeliveryKind != contracts.Delta {
		return false
	}
	if evidence.ThroughRevision != nil &&
		*evidence.ThroughRevision <= binding.ResultEvidenceRevision {
		return false
	}
	return evidence.FromRevision == nil || evidence.ThroughRevision == nil ||
		*evidence.FromRevision != binding.ResultEvidenceRevision
}

func prepareRoomContextForSession(
	run contracts.RunRequestedPayload,
	binding RuntimeSessionBinding,
	disposition contracts.Disposition,
) (contracts.RunRequestedPayload, *contracts.BridgeRoomContextConsumption, error) {
	bundleSource := run.RoomContextBundle
	if bundleSource == nil {
		return run, nil, nil
	}
	if run.TaskID == nil || strings.TrimSpace(*run.TaskID) == "" || run.Session == nil ||
		run.Session.Scope != contracts.Task {
		return run, nil, fmt.Errorf("Room context coverage requires a logical Task Session")
	}
	bundle := *bundleSource
	raw := bundle.RawTail
	raw.Messages = append([]contracts.Message(nil), raw.Messages...)
	if bundle.TargetThroughSequence < 1 ||
		bundle.TargetThroughSequence != run.Session.ContextCursor ||
		bundle.PriorContextThroughSequence != bundle.TargetThroughSequence-1 ||
		bundle.RequestMessageID != run.TriggerMessageID || len(run.ContextMessages) != 0 {
		return run, nil, fmt.Errorf("Room context bundle does not match the current request")
	}
	if raw.FromSequenceExclusive < 0 || raw.ThroughSequenceInclusive < 0 ||
		raw.ThroughSequenceInclusive != bundle.PriorContextThroughSequence ||
		raw.MessageCount != int64(len(raw.Messages)) || raw.MessageCount > 12 ||
		raw.Utf8Bytes < 0 || raw.Utf8Bytes > 10_240 {
		return run, nil, fmt.Errorf("Room context raw tail is outside its bounds")
	}
	checkpointThrough := int64(0)
	if bundle.Checkpoint != nil {
		checkpoint := bundle.Checkpoint
		checkpointThrough = checkpoint.ThroughSequence
		if checkpoint.FromSequenceExclusive < 0 || checkpoint.ThroughSequence < 1 ||
			checkpoint.FromSequenceExclusive >= checkpoint.ThroughSequence ||
			checkpoint.ThroughSequence > bundle.PriorContextThroughSequence ||
			checkpoint.SourceMessageCount != checkpoint.ThroughSequence-checkpoint.FromSequenceExclusive ||
			strings.TrimSpace(checkpoint.Summary) == "" || len([]rune(checkpoint.Summary)) > 12_000 ||
			len(checkpoint.ProvenanceMessageIDS) == 0 || len(checkpoint.ProvenanceMessageIDS) > 64 ||
			!lowerHexDigest(checkpoint.SourceDigest) ||
			(checkpoint.BuildKind != contracts.Incremental && checkpoint.BuildKind != contracts.Rebase) {
			return run, nil, fmt.Errorf("Room context checkpoint is invalid")
		}
		seen := make(map[string]struct{}, len(checkpoint.ProvenanceMessageIDS))
		for _, messageID := range checkpoint.ProvenanceMessageIDS {
			if strings.TrimSpace(messageID) == "" {
				return run, nil, fmt.Errorf("Room context checkpoint provenance is invalid")
			}
			if _, duplicate := seen[messageID]; duplicate {
				return run, nil, fmt.Errorf("Room context checkpoint provenance is duplicated")
			}
			seen[messageID] = struct{}{}
		}
	} else if bundle.PriorContextThroughSequence != 0 {
		return run, nil, fmt.Errorf("Room context bundle omitted its checkpoint")
	}
	if raw.FromSequenceExclusive != checkpointThrough ||
		raw.ThroughSequenceInclusive-raw.FromSequenceExclusive != raw.MessageCount {
		return run, nil, fmt.Errorf("Room context checkpoint and raw tail are discontinuous")
	}
	utf8Bytes := int64(0)
	messageIDs := make(map[string]struct{}, len(raw.Messages))
	for index, message := range raw.Messages {
		expectedSequence := raw.FromSequenceExclusive + int64(index) + 1
		if message.Sequence == nil || *message.Sequence != expectedSequence ||
			message.MessageID == run.TriggerMessageID || strings.TrimSpace(message.MessageID) == "" {
			return run, nil, fmt.Errorf("Room context raw tail has a gap or overlap")
		}
		if _, duplicate := messageIDs[message.MessageID]; duplicate {
			return run, nil, fmt.Errorf("Room context raw tail repeats a Message")
		}
		messageIDs[message.MessageID] = struct{}{}
		utf8Bytes += int64(len([]byte(message.Content)))
	}
	if utf8Bytes != raw.Utf8Bytes {
		return run, nil, fmt.Errorf("Room context raw tail byte count does not match")
	}

	baseCursor := int64(0)
	if disposition == contracts.Resumed {
		baseCursor = binding.LastRoomSequence
	}
	if baseCursor < 0 {
		return run, nil, fmt.Errorf("Room context base cursor cannot be negative")
	}
	includeCheckpoint := bundle.Checkpoint != nil &&
		(disposition != contracts.Resumed || checkpointThrough > baseCursor)
	if !includeCheckpoint {
		bundle.Checkpoint = nil
		selectedFrom := baseCursor
		if selectedFrom < checkpointThrough {
			selectedFrom = checkpointThrough
		}
		if selectedFrom > raw.ThroughSequenceInclusive {
			selectedFrom = raw.ThroughSequenceInclusive
		}
		selected := make([]contracts.Message, 0, len(raw.Messages))
		for _, message := range raw.Messages {
			if message.Sequence != nil && *message.Sequence > selectedFrom {
				selected = append(selected, message)
			}
		}
		raw.FromSequenceExclusive = selectedFrom
		raw.Messages = selected
		raw.MessageCount = int64(len(selected))
		raw.Utf8Bytes = messageContentBytes(selected)
	}
	bundle.RawTail = raw
	run.RoomContextBundle = &bundle
	coverageCursor := bundle.TargetThroughSequence
	if baseCursor > coverageCursor {
		coverageCursor = baseCursor
	}
	receipt := &contracts.BridgeRoomContextConsumption{
		BaseContextCursor:           baseCursor,
		RawFromSequenceExclusive:    raw.FromSequenceExclusive,
		RawThroughSequenceInclusive: raw.ThroughSequenceInclusive,
		RawMessageCount:             raw.MessageCount,
		CoverageThroughSequence:     coverageCursor,
	}
	if includeCheckpoint {
		checkpointID := bundle.Checkpoint.CheckpointID
		receipt.CheckpointID = &checkpointID
	}
	return run, receipt, nil
}

func messageContentBytes(messages []contracts.Message) int64 {
	total := int64(0)
	for _, message := range messages {
		total += int64(len([]byte(message.Content)))
	}
	return total
}

func lowerHexDigest(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
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
	roomContextConsumption *contracts.BridgeRoomContextConsumption,
) *contracts.LogicalSessionStatus {
	return &contracts.LogicalSessionStatus{
		Disposition:            disposition,
		ContextCursor:          contextCursor,
		RuntimeScopeID:         &runtimeScopeID,
		ResultEvidenceRevision: &resultEvidenceRevision,
		RoomContextConsumption: roomContextConsumption,
	}
}

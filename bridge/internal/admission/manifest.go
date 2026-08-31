package admission

import (
	"encoding/json"
	"time"

	contracts "convenewire.dev/contracts/generated/go"
	execution "convenewire.dev/contracts/generated/go/execution"
	wire "convenewire.dev/contracts/generated/go/runtime"
)

// DecodeGovernedManifest converts the current Codex-governed delivery
// representation only after joining it to the exact outer Run and frozen
// Context Manifest identities. It performs no local grant, repository, profile
// or current-authority check.
func DecodeGovernedManifest(request contracts.RunRequestedPayload) (execution.GovernedExecutionManifest, error) {
	var manifest execution.GovernedExecutionManifest
	contextManifest := request.ContextManifest
	if contextManifest == nil || contextManifest.Execution == nil || request.TaskID == nil ||
		contextManifest.Target.DeviceID == nil || contextManifest.ManifestVersion != contracts.The10 ||
		contextManifest.Target.RuntimeKind != contracts.Codex || request.Deadline.IsZero() {
		return manifest, ErrAdmissionInvalid
	}
	raw, err := json.Marshal(contextManifest.Execution)
	if err != nil || wire.ValidateExecutionCommand("executionManifest", raw) != nil || json.Unmarshal(raw, &manifest) != nil {
		return manifest, ErrAdmissionInvalid
	}
	manifestDigest, err := executionDigest(manifest, "manifestDigest")
	if err != nil || manifestDigest != manifest.ManifestDigest {
		return execution.GovernedExecutionManifest{}, ErrAdmissionInvalid
	}
	inputDigest, err := executionDigest(manifest.Inputs, "")
	if err != nil || inputDigest != manifest.InputDigest {
		return execution.GovernedExecutionManifest{}, ErrAdmissionInvalid
	}
	deadline, deadlineErr := time.Parse(time.RFC3339Nano, manifest.Deadline)
	workspaceIssuedAt, issuedErr := time.Parse(time.RFC3339Nano, manifest.Workspace.IssuedAt)
	scope := manifest.Scope
	if deadlineErr != nil || issuedErr != nil || !request.Deadline.UTC().Equal(deadline) || contextManifest.RecordedAt.IsZero() ||
		contextManifest.RecordedAt.UTC().After(workspaceIssuedAt) || request.RunID != scope.RunID || contextManifest.RunID != scope.RunID ||
		request.RoomID != scope.RoomID || request.TargetAgentID != scope.AgentID || contextManifest.Target.AgentID != scope.AgentID ||
		*contextManifest.Target.DeviceID != scope.DeviceID || *request.TaskID != scope.TaskID || contextManifest.TaskID != scope.TaskID ||
		contextManifest.TaskRevision != scope.TaskRevision || contextManifest.DefinitionRevision != scope.DefinitionRevision ||
		contextManifest.CriteriaRevision != scope.CriteriaRevision {
		return execution.GovernedExecutionManifest{}, ErrAdmissionInvalid
	}
	return manifest, nil
}

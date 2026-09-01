package admission

import (
	"reflect"
	"time"

	contracts "convenewire.dev/contracts/generated/go"
)

// RuntimeRecoveryFence intentionally exposes only restart inventory and exact
// closure. It cannot Claim or Start a Runtime and therefore cannot become a
// second admission path when composed by the managed core.
type RuntimeRecoveryFence struct {
	store *RuntimeFenceStore
}

func (f *RuntimeRecoveryFence) List() ([]RuntimeAdmissionView, error) {
	if f == nil || f.store == nil {
		return nil, ErrAdmissionInvalid
	}
	return f.store.List()
}

func (f *RuntimeRecoveryFence) Stop(runID, admissionDigest, startDigest string, outcome RuntimeOutcome,
	now time.Time) (RuntimeAdmissionView, error) {
	if f == nil || f.store == nil {
		return RuntimeAdmissionView{}, ErrAdmissionInvalid
	}
	return f.store.Stop(runID, admissionDigest, startDigest, outcome, now)
}

// ValidateRuntimeAdmissionRequest proves that restart inventory belongs to the
// exact immutable governed delivery. Prepared workspace identity remains bound
// by the admission digest even though local paths never enter the Inbox.
func ValidateRuntimeAdmissionRequest(request contracts.RunRequestedPayload, view RuntimeAdmissionView) error {
	manifest, err := DecodeGovernedManifest(request)
	if err != nil || !validRuntimeAdmissionSpec(view.Spec) || !sha256Digest.MatchString(view.AdmissionDigest) {
		return ErrAdmissionInvalid
	}
	scope := manifest.Scope
	repository := manifest.Repository
	grant := manifest.Grant
	workspace := manifest.Workspace
	want := RuntimeAdmissionSpec{
		RunID: scope.RunID, TaskID: scope.TaskID, AgentID: scope.AgentID, DeviceID: scope.DeviceID,
		PlanID: scope.PlanID, PlanRevision: scope.PlanRevision, PlanDigest: scope.PlanDigest,
		ApprovalOperationID: scope.ApprovalOperationID, PlanControlRevision: scope.PlanControlRevision,
		NodeKey: scope.NodeKey, DispatchGeneration: scope.DispatchGeneration, RoomID: scope.RoomID,
		TaskRevision: scope.TaskRevision, DefinitionRevision: scope.DefinitionRevision,
		CriteriaRevision: scope.CriteriaRevision, ManifestDigest: manifest.ManifestDigest,
		GrantID: grant.GrantID, GrantRevision: grant.Revision, GrantDigest: grant.Digest,
		RepositoryID: repository.RepositoryID, BindingID: repository.BindingID,
		LeaseID: workspace.LeaseID, WorkspaceRef: workspace.WorkspaceRef,
		WorkspaceGeneration: workspace.WorkspaceGeneration, RuntimeProfileID: repository.RuntimeProfileID,
		RuntimeProfileDigest: repository.RuntimeProfileDigest, BaseCommit: repository.BaseCommit,
		WorkspaceIssuedAt: workspace.IssuedAt, WorkspaceExpiresAt: workspace.ExpiresAt,
		GrantExpiresAt: grant.ExpiresAt, Deadline: manifest.Deadline,
	}
	got := view.Spec
	// These fields are created only by local preparation/profile verification
	// and cannot be reconstructed from wire delivery during restart.
	want.RuntimeProfileRevision = got.RuntimeProfileRevision
	want.PreparedOperationID = got.PreparedOperationID
	want.PreparedIntentDigest = got.PreparedIntentDigest
	want.PreparedIdentityDigest = got.PreparedIdentityDigest
	want.PreparedCommit = got.PreparedCommit
	want.PreparedTree = got.PreparedTree
	want.OutputBaseCommit = got.OutputBaseCommit
	if !reflect.DeepEqual(got, want) {
		return ErrAdmissionChanged
	}
	return nil
}

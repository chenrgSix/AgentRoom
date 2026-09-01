package delivery

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"convenewire.dev/bridge/internal/admission"
	contracts "convenewire.dev/contracts/generated/go"
)

func TestGovernedRecoveryFencesPossibleStartBeforeClosingInboxUnknown(t *testing.T) {
	inbox, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	request := governedRecoveryRequest(t)
	now := time.Date(2026, 9, 1, 8, 0, 0, 0, time.UTC)
	record, _, err := inbox.Accept(request, now)
	if err != nil {
		t.Fatal(err)
	}
	working := contracts.RunStatusMessage{ProtocolVersion: "1.0", MessageID: "msg_recoveryworking01",
		Timestamp: now, Type: contracts.RunStatus, Payload: contracts.RunStatusPayload{RunID: record.RunID,
			AgentID: record.Request.TargetAgentID, TraceID: record.Request.TraceID, Sequence: 2, Status: contracts.Working}}
	if record, err = inbox.AppendEvent(record.RunID, StateWorking, 2, working, now); err != nil {
		t.Fatal(err)
	}
	view := governedRecoveryView(t, request, admission.RuntimeAdmissionStarting)
	fence := &governedRecoveryFenceStub{views: []admission.RuntimeAdmissionView{view}}
	processes := &governedProcessFencerStub{}
	executor := &RuntimeExecutor{Inbox: inbox, Now: func() time.Time { return now.Add(time.Minute) }}
	recovery := &GovernedRecovery{Inbox: inbox, Fence: fence, Processes: processes, Executor: executor,
		Now: func() time.Time { return now.Add(time.Minute) }}
	var sent []any
	if err := recovery.Recover(context.Background(), collectGoverned(&sent)); err != nil {
		t.Fatal(err)
	}
	if processes.allCalls != 1 || processes.calls != 1 || fence.stopCalls != 1 || len(sent) != 3 {
		t.Fatalf("all=%d process=%d stop=%d sent=%d", processes.allCalls, processes.calls, fence.stopCalls, len(sent))
	}
	latest, err := inbox.Get(record.RunID)
	if err != nil || latest.State != StateOutcomeUnknown || latest.LastSequence != 3 {
		t.Fatalf("record=%+v err=%v", latest, err)
	}
	statuses := governedRecoveryStatuses(t, sent)
	if len(statuses) != 2 || statuses[0] != contracts.Working || statuses[1] != contracts.OutcomeUnknown {
		t.Fatalf("statuses=%v", statuses)
	}

	sent = nil
	if err := recovery.Recover(context.Background(), collectGoverned(&sent)); err != nil {
		t.Fatal(err)
	}
	if processes.allCalls != 2 || processes.calls != 1 || fence.stopCalls != 1 || len(sent) != 3 {
		t.Fatalf("replay all=%d process=%d stop=%d sent=%d", processes.allCalls, processes.calls, fence.stopCalls, len(sent))
	}
}

func TestGovernedRecoveryLeavesNoStartClaimForExactRedelivery(t *testing.T) {
	recovery, inbox, fence, processes, request := governedRecoveryFixture(t, admission.RuntimeAdmissionClaimed)
	var sent []any
	if err := recovery.Recover(context.Background(), collectGoverned(&sent)); err != nil {
		t.Fatal(err)
	}
	record, err := inbox.Get(request.RunID)
	if err != nil || record.State != StateAccepted || len(sent) != 0 || processes.allCalls != 1 ||
		processes.calls != 0 || fence.stopCalls != 0 {
		t.Fatalf("record=%+v err=%v sent=%d all=%d process=%d stop=%d", record, err, len(sent),
			processes.allCalls, processes.calls, fence.stopCalls)
	}
}

func TestGovernedRecoveryFencesBeforeReplayingPersistedTerminal(t *testing.T) {
	recovery, inbox, fence, processes, request := governedRecoveryFixture(t, admission.RuntimeAdmissionStarting)
	now := recovery.now()
	record, err := inbox.Get(request.RunID)
	if err != nil {
		t.Fatal(err)
	}
	completed := contracts.RunStatusMessage{ProtocolVersion: "1.0", MessageID: "msg_recoverycomplete01",
		Timestamp: now, Type: contracts.RunStatus, Payload: contracts.RunStatusPayload{RunID: record.RunID,
			AgentID: record.Request.TargetAgentID, TraceID: record.Request.TraceID, Sequence: 2, Status: contracts.Completed}}
	if _, err := inbox.AppendEvent(record.RunID, StateCompleted, 2, completed, now); err != nil {
		t.Fatal(err)
	}
	var sent []any
	if err := recovery.Recover(context.Background(), collectGoverned(&sent)); err != nil {
		t.Fatal(err)
	}
	latest, err := inbox.Get(record.RunID)
	statuses := governedRecoveryStatuses(t, sent)
	if err != nil || latest.State != StateCompleted || latest.LastSequence != 2 || processes.calls != 1 ||
		fence.stopCalls != 1 || len(statuses) != 1 || statuses[0] != contracts.Completed {
		t.Fatalf("record=%+v err=%v process=%d stop=%d statuses=%v", latest, err,
			processes.calls, fence.stopCalls, statuses)
	}
}

func TestGovernedRecoverAllOrdersGovernedFenceBeforeOrdinaryRecovery(t *testing.T) {
	recovery, inbox, fence, processes, _ := governedRecoveryFixture(t, admission.RuntimeAdmissionStarting)
	now := recovery.now()
	ordinary := testRunMessage("run_recoverallordinary01", "agent_recoverallordinary01").Payload
	if _, _, err := inbox.Accept(ordinary, now); err != nil {
		t.Fatal(err)
	}
	var sent []any
	if err := recovery.RecoverAll(context.Background(), collectGoverned(&sent)); err != nil {
		t.Fatal(err)
	}
	ordinaryRecord, err := inbox.Get(ordinary.RunID)
	if err != nil || ordinaryRecord.State != StateOutcomeUnknown || processes.calls != 1 || fence.stopCalls != 1 {
		t.Fatalf("ordinary=%+v err=%v process=%d stop=%d", ordinaryRecord, err, processes.calls, fence.stopCalls)
	}
}

func TestGovernedRecoveryNeverClosesFenceUntilProcessAbsenceIsProved(t *testing.T) {
	recovery, inbox, fence, processes, request := governedRecoveryFixture(t, admission.RuntimeAdmissionStarting)
	processes.err = errors.New("surviving process identity unavailable")
	if err := recovery.Recover(context.Background(), func(context.Context, any) error { return nil }); !errors.Is(err, processes.err) {
		t.Fatalf("error=%v", err)
	}
	record, err := inbox.Get(request.RunID)
	if err != nil || record.State != StateAccepted || fence.stopCalls != 0 {
		t.Fatalf("record=%+v err=%v stop=%d", record, err, fence.stopCalls)
	}
}

func TestGovernedRecoveryFencesProcessInventoryBeforeReadingAdmission(t *testing.T) {
	recovery, inbox, fence, processes, request := governedRecoveryFixture(t, admission.RuntimeAdmissionClaimed)
	processes.allErr = errors.New("process inventory could not be fenced")
	if err := recovery.Recover(context.Background(), func(context.Context, any) error { return nil }); !errors.Is(err, processes.allErr) {
		t.Fatalf("error=%v", err)
	}
	record, err := inbox.Get(request.RunID)
	if err != nil || record.State != StateAccepted || processes.allCalls != 1 || fence.listCalls != 0 {
		t.Fatalf("record=%+v err=%v all=%d list=%d", record, err, processes.allCalls, fence.listCalls)
	}
}

func TestGovernedRecoveryFencesOrphanPossibleStartAndKeepsBridgeOffline(t *testing.T) {
	request := governedRecoveryRequest(t)
	view := governedRecoveryView(t, request, admission.RuntimeAdmissionStarting)
	inbox, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	fence := &governedRecoveryFenceStub{views: []admission.RuntimeAdmissionView{view}}
	processes := &governedProcessFencerStub{}
	executor := &RuntimeExecutor{Inbox: inbox}
	recovery := &GovernedRecovery{Inbox: inbox, Fence: fence, Processes: processes, Executor: executor}
	if err := recovery.Recover(context.Background(), func(context.Context, any) error { return nil }); !errors.Is(err, ErrGovernedRecoveryInconsistent) {
		t.Fatalf("error=%v", err)
	}
	if processes.calls != 1 || fence.stopCalls != 1 || fence.views[0].State != admission.RuntimeAdmissionStopped {
		t.Fatalf("process=%d stop=%d view=%+v", processes.calls, fence.stopCalls, fence.views[0])
	}
}

func TestOrdinaryRecoveryRejectsGovernedInventoryBeforeMutation(t *testing.T) {
	inbox, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 1, 8, 0, 0, 0, time.UTC)
	governed := governedRecoveryRequest(t)
	if _, _, err := inbox.Accept(governed, now); err != nil {
		t.Fatal(err)
	}
	ordinary := testRunMessage("run_ordinaryrecovery01", "agent_ordinaryrecovery01").Payload
	if _, _, err := inbox.Accept(ordinary, now); err != nil {
		t.Fatal(err)
	}
	var sent []any
	if err := (RuntimeExecutor{Inbox: inbox, Now: func() time.Time { return now }}).Recover(
		context.Background(), collectGoverned(&sent)); !errors.Is(err, ErrGovernedExecutionUnsupported) {
		t.Fatalf("error=%v", err)
	}
	ordinaryRecord, err := inbox.Get(ordinary.RunID)
	if err != nil || ordinaryRecord.State != StateAccepted || len(sent) != 0 {
		t.Fatalf("ordinary=%+v err=%v sent=%d", ordinaryRecord, err, len(sent))
	}
}

type governedRecoveryFenceStub struct {
	views     []admission.RuntimeAdmissionView
	listCalls int
	stopCalls int
}

func (s *governedRecoveryFenceStub) List() ([]admission.RuntimeAdmissionView, error) {
	s.listCalls++
	return append([]admission.RuntimeAdmissionView{}, s.views...), nil
}

func (s *governedRecoveryFenceStub) Stop(runID, admissionDigest, startDigest string,
	outcome admission.RuntimeOutcome, now time.Time) (admission.RuntimeAdmissionView, error) {
	s.stopCalls++
	for index := range s.views {
		view := s.views[index]
		if view.Spec.RunID != runID {
			continue
		}
		if view.AdmissionDigest != admissionDigest || view.StartDigest == nil || *view.StartDigest != startDigest ||
			outcome != admission.RuntimeOutcomeUnknown || now.IsZero() {
			return admission.RuntimeAdmissionView{}, admission.ErrAdmissionConflict
		}
		stoppedAt := now.UTC().Format(time.RFC3339Nano)
		view.State, view.Outcome, view.StoppedAt = admission.RuntimeAdmissionStopped, &outcome, &stoppedAt
		s.views[index] = view
		return view, nil
	}
	return admission.RuntimeAdmissionView{}, admission.ErrAdmissionInvalid
}

type governedProcessFencerStub struct {
	allCalls int
	calls    int
	allErr   error
	err      error
}

func (s *governedProcessFencerStub) FenceAll(context.Context) error {
	s.allCalls++
	return s.allErr
}

func (s *governedProcessFencerStub) FenceAndWait(_ context.Context, view admission.RuntimeAdmissionView) error {
	s.calls++
	if view.State != admission.RuntimeAdmissionStarting || view.StartDigest == nil {
		return admission.ErrAdmissionInvalid
	}
	return s.err
}

func governedRecoveryFixture(t *testing.T, state string) (*GovernedRecovery, *Inbox,
	*governedRecoveryFenceStub, *governedProcessFencerStub, contracts.RunRequestedPayload) {
	t.Helper()
	inbox, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	request := governedRecoveryRequest(t)
	now := time.Date(2026, 9, 1, 8, 0, 0, 0, time.UTC)
	if _, _, err := inbox.Accept(request, now); err != nil {
		t.Fatal(err)
	}
	fence := &governedRecoveryFenceStub{views: []admission.RuntimeAdmissionView{governedRecoveryView(t, request, state)}}
	processes := &governedProcessFencerStub{}
	executor := &RuntimeExecutor{Inbox: inbox, Now: func() time.Time { return now.Add(time.Minute) }}
	return &GovernedRecovery{Inbox: inbox, Fence: fence, Processes: processes, Executor: executor,
		Now: func() time.Time { return now.Add(time.Minute) }}, inbox, fence, processes, request
}

func governedRecoveryRequest(t *testing.T) contracts.RunRequestedPayload {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "packages", "contracts", "fixtures", "execution-runtime-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var suite struct {
		Cases []struct {
			Name     string
			Instance struct {
				Payload json.RawMessage `json:"payload"`
			} `json:"instance"`
		}
	}
	if err := json.Unmarshal(raw, &suite); err != nil {
		t.Fatal(err)
	}
	for _, entry := range suite.Cases {
		if entry.Name == "execution runtime: valid governed wire delivery" {
			var request contracts.RunRequestedPayload
			if err := json.Unmarshal(entry.Instance.Payload, &request); err != nil {
				t.Fatal(err)
			}
			return request
		}
	}
	t.Fatal("governed delivery fixture missing")
	return contracts.RunRequestedPayload{}
}

func governedRecoveryView(t *testing.T, request contracts.RunRequestedPayload, state string) admission.RuntimeAdmissionView {
	t.Helper()
	manifest, err := admission.DecodeGovernedManifest(request)
	if err != nil {
		t.Fatal(err)
	}
	scope, repository, grant, workspace := manifest.Scope, manifest.Repository, manifest.Grant, manifest.Workspace
	view := admission.RuntimeAdmissionView{State: state, AdmissionDigest: strings.Repeat("a", 64),
		ClaimedAt: "2026-08-31T10:05:00Z", Spec: admission.RuntimeAdmissionSpec{
			RunID: scope.RunID, TaskID: scope.TaskID, AgentID: scope.AgentID, DeviceID: scope.DeviceID,
			PlanID: scope.PlanID, PlanRevision: scope.PlanRevision, PlanDigest: scope.PlanDigest,
			ApprovalOperationID: scope.ApprovalOperationID, PlanControlRevision: scope.PlanControlRevision,
			NodeKey: scope.NodeKey, DispatchGeneration: scope.DispatchGeneration, RoomID: scope.RoomID,
			TaskRevision: scope.TaskRevision, DefinitionRevision: scope.DefinitionRevision,
			CriteriaRevision: scope.CriteriaRevision, ManifestDigest: manifest.ManifestDigest,
			GrantID: grant.GrantID, GrantRevision: grant.Revision, GrantDigest: grant.Digest,
			RepositoryID: repository.RepositoryID, BindingID: repository.BindingID, LeaseID: workspace.LeaseID,
			WorkspaceRef: workspace.WorkspaceRef, WorkspaceGeneration: workspace.WorkspaceGeneration,
			RuntimeProfileID: repository.RuntimeProfileID, RuntimeProfileRevision: 1,
			RuntimeProfileDigest: repository.RuntimeProfileDigest, PreparedOperationID: "op_recoveryprepare01",
			PreparedIntentDigest: strings.Repeat("b", 64), PreparedIdentityDigest: strings.Repeat("c", 64),
			BaseCommit: repository.BaseCommit, PreparedCommit: strings.Repeat("d", 40), PreparedTree: strings.Repeat("e", 40),
			WorkspaceIssuedAt: workspace.IssuedAt, WorkspaceExpiresAt: workspace.ExpiresAt,
			GrantExpiresAt: grant.ExpiresAt, Deadline: manifest.Deadline,
		}}
	if state == admission.RuntimeAdmissionStarting || state == admission.RuntimeAdmissionStopped {
		startDigest, checked := strings.Repeat("f", 64), "2026-08-31T10:06:00Z"
		view.StartDigest, view.AuthorityCheckedAt = &startDigest, &checked
	}
	if state == admission.RuntimeAdmissionStopped {
		outcome, stopped := admission.RuntimeOutcomeUnknown, "2026-08-31T10:07:00Z"
		view.Outcome, view.StoppedAt = &outcome, &stopped
	}
	return view
}

func governedRecoveryStatuses(t *testing.T, sent []any) []contracts.RunExecutionStatus {
	t.Helper()
	var statuses []contracts.RunExecutionStatus
	for _, value := range sent {
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		var envelope struct {
			Type    string `json:"type"`
			Payload struct {
				Status contracts.RunExecutionStatus `json:"status"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(raw, &envelope); err != nil {
			t.Fatal(err)
		}
		if envelope.Type == string(contracts.RunStatus) {
			statuses = append(statuses, envelope.Payload.Status)
		}
	}
	return statuses
}

package admission

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"convenewire.dev/bridge/internal/artifact"
	"convenewire.dev/bridge/internal/repository"
	bridgeruntime "convenewire.dev/bridge/internal/runtime"
	execution "convenewire.dev/contracts/generated/go/execution"
)

func TestGovernedCaptureCoordinatorPublishesExactFrozenIntent(t *testing.T) {
	admissionCoordinator, rig, request := governedCoordinatorFixture(t)
	ticket, err := admissionCoordinator.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	decision, err := admissionCoordinator.Start(context.Background(), ticket)
	if err != nil {
		t.Fatal(err)
	}
	bindings := &captureBindingsStub{manifest: ticket.manifest}
	processes := &captureProcessStub{}
	preparer := &capturePreparerStub{checkpoint: captureCheckpoint(ticket.manifest)}
	coordinator, err := newGovernedCaptureCoordinator(bindings, preparer, rig, processes, &captureTransportStub{})
	if err != nil {
		t.Fatal(err)
	}
	coordinator.now = func() time.Time { return runtimeFenceNow.Add(time.Minute) }
	checkpoint, err := coordinator.CaptureCompleted(context.Background(), ticket, decision)
	if err != nil {
		t.Fatal(err)
	}
	wantIdentity := bridgeruntime.GovernedProcessIdentity{RunID: decision.View.Spec.RunID,
		AdmissionDigest: decision.View.AdmissionDigest, StartDigest: *decision.View.StartDigest}
	if bindings.calls != 1 || bindings.operation != execution.Capture || processes.calls != 1 ||
		processes.identity != wantIdentity || preparer.captureCalls != 1 || preparer.publishCalls != 1 ||
		checkpoint.OperationID != ticket.manifest.Capture.OperationID {
		t.Fatalf("bindings=%+v processes=%+v preparer=%+v checkpoint=%+v", bindings, processes, preparer, checkpoint)
	}
	wantCapture := repository.CaptureRequest{OperationID: ticket.manifest.Capture.OperationID,
		WorkspaceRef: decision.View.Spec.WorkspaceRef, PreparedDigest: decision.View.Spec.PreparedIntentDigest,
		ExpectedGeneration: decision.View.Spec.WorkspaceGeneration, ManifestDigest: decision.View.Spec.ManifestDigest}
	if preparer.capture != wantCapture || preparer.publication.CaptureDigest != strings.Repeat("d", 64) ||
		preparer.publication.Operation.OperationID != ticket.manifest.Capture.OperationID ||
		preparer.publication.Operation.Plan.RootTaskID != ticket.manifest.Capture.RootTaskID ||
		len(preparer.publication.Outputs) != 1 || preparer.publication.Outputs[0].Path != "" {
		t.Fatalf("capture=%+v publication=%+v", preparer.capture, preparer.publication)
	}
	digest, err := executionDigest(preparer.publication.Operation, "requestDigest")
	if err != nil || digest != preparer.publication.Operation.RequestDigest {
		t.Fatalf("request digest=%q err=%v operation=%+v", digest, err, preparer.publication.Operation)
	}
}

func TestGovernedCaptureCoordinatorFailsClosedBeforeLocalCapture(t *testing.T) {
	tests := []struct {
		name      string
		configure func(*GovernedAdmissionTicket, *GovernedStartDecision, *coordinatorRig, *captureBindingsStub, *captureProcessStub)
		wantError error
	}{
		{name: "capture grant denied", configure: func(_ *GovernedAdmissionTicket, _ *GovernedStartDecision, _ *coordinatorRig,
			bindings *captureBindingsStub, _ *captureProcessStub) {
			bindings.err = repository.ErrGrantDenied
		}, wantError: repository.ErrGrantDenied},
		{name: "process not finished", configure: func(_ *GovernedAdmissionTicket, _ *GovernedStartDecision, _ *coordinatorRig,
			_ *captureBindingsStub, processes *captureProcessStub) {
			processes.err = ErrAdmissionChanged
		}, wantError: ErrAdmissionChanged},
		{name: "admission changed", configure: func(_ *GovernedAdmissionTicket, _ *GovernedStartDecision, rig *coordinatorRig,
			_ *captureBindingsStub, _ *captureProcessStub) {
			rig.start.AdmissionDigest = strings.Repeat("7", 64)
		}, wantError: ErrAdmissionChanged},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			admissionCoordinator, rig, request := governedCoordinatorFixture(t)
			ticket, err := admissionCoordinator.Prepare(context.Background(), request)
			if err != nil {
				t.Fatal(err)
			}
			decision, err := admissionCoordinator.Start(context.Background(), ticket)
			if err != nil {
				t.Fatal(err)
			}
			bindings := &captureBindingsStub{manifest: ticket.manifest}
			processes := &captureProcessStub{}
			preparer := &capturePreparerStub{checkpoint: captureCheckpoint(ticket.manifest)}
			test.configure(&ticket, &decision, rig, bindings, processes)
			coordinator, err := newGovernedCaptureCoordinator(bindings, preparer, rig, processes, &captureTransportStub{})
			if err != nil {
				t.Fatal(err)
			}
			coordinator.now = func() time.Time { return runtimeFenceNow.Add(time.Minute) }
			if _, err := coordinator.CaptureCompleted(context.Background(), ticket, decision); !errors.Is(err, test.wantError) ||
				preparer.captureCalls != 0 || preparer.publishCalls != 0 {
				t.Fatalf("error=%v captureCalls=%d publishCalls=%d", err, preparer.captureCalls, preparer.publishCalls)
			}
		})
	}
}

func TestCapturePublicationRejectsUnapprovedFrozenOutputBeforeIO(t *testing.T) {
	_, _, request := governedCoordinatorFixture(t)
	manifest, err := DecodeGovernedManifest(request)
	if err != nil {
		t.Fatal(err)
	}
	path := "src/change.patch"
	manifest.Capture.Outputs[0].Path = &path
	manifest.ManifestDigest, err = executionDigest(manifest, "manifestDigest")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := capturePublication(manifest); !errors.Is(err, repository.ErrInvalid) {
		t.Fatalf("error=%v", err)
	}
}

type captureBindingsStub struct {
	manifest  execution.GovernedExecutionManifest
	operation execution.KindElement
	calls     int
	err       error
}

func (s *captureBindingsStub) CheckTaskGrant(_ context.Context, manifest execution.GovernedExecutionManifest,
	operation execution.KindElement, _ time.Time) error {
	s.calls++
	s.operation = operation
	if !reflect.DeepEqual(manifest, s.manifest) || operation != execution.Capture {
		return ErrAdmissionChanged
	}
	return s.err
}

func (*captureBindingsStub) ResolveSource(context.Context, string, string, int) (repository.Source, error) {
	return repository.Source{}, errors.New("capture must not resolve a source")
}

type captureProcessStub struct {
	identity bridgeruntime.GovernedProcessIdentity
	calls    int
	err      error
}

func (s *captureProcessStub) RequireFinished(identity bridgeruntime.GovernedProcessIdentity) error {
	s.calls++
	s.identity = identity
	return s.err
}

type capturePreparerStub struct {
	capture      repository.CaptureRequest
	publication  repository.CapturePublication
	checkpoint   execution.RepositoryCheckpoint
	captureCalls int
	publishCalls int
}

func (s *capturePreparerStub) Capture(_ context.Context, request repository.CaptureRequest) (repository.CapturedRepository, error) {
	s.captureCalls++
	s.capture = request
	return repository.CapturedRepository{Digest: strings.Repeat("d", 64)}, nil
}

func (s *capturePreparerStub) PublishCaptured(_ context.Context, publication repository.CapturePublication,
	_ repository.CaptureTransport) (execution.RepositoryCheckpoint, error) {
	s.publishCalls++
	s.publication = publication
	return s.checkpoint, nil
}

type captureTransportStub struct{}

func (*captureTransportStub) CaptureCheckpoint(context.Context, string) (*execution.RepositoryCheckpoint, error) {
	return nil, nil
}

func (*captureTransportStub) PublishCapture(context.Context, artifact.CapturePublishInput) (artifact.PublishResult, error) {
	return artifact.PublishResult{}, nil
}

func (*captureTransportStub) SealCaptureCheckpoint(_ context.Context,
	checkpoint execution.RepositoryCheckpoint) (execution.RepositoryCheckpoint, error) {
	return checkpoint, nil
}

func captureCheckpoint(manifest execution.GovernedExecutionManifest) execution.RepositoryCheckpoint {
	return execution.RepositoryCheckpoint{OperationID: manifest.Capture.OperationID,
		RepositoryID: manifest.Repository.RepositoryID, BindingID: manifest.Repository.BindingID,
		WorkspaceRef: manifest.Workspace.WorkspaceRef, WorkspaceGeneration: manifest.Workspace.WorkspaceGeneration,
		Scope: execution.RepositoryCheckpointScope{RunID: manifest.Scope.RunID}}
}

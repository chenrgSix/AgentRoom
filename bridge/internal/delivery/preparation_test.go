package delivery

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	contracts "convenewire.dev/contracts/generated/go"
)

func verifiedMaterializationReceipt() contracts.VerifiedArtifactMaterializationReceipt {
	return contracts.VerifiedArtifactMaterializationReceipt{
		ArtifactID:           "artifact_prepare_12345678",
		ContentID:            "content_prepare_12345678",
		LogicalAlias:         "artifact://artifact_prepare_12345678/result.patch",
		MaterializationState: contracts.Verified,
		MediaType:            contracts.TextXDiff,
		Sha256:               "a8f5f167f44f4964e6c998dee827110cffe2f23f5fe2d80f063b3b0781d2ea3b",
		SizeBytes:            42,
	}
}

func materializationRunMessage(runID string, agentID string) contracts.RunRequestedMessage {
	message := testRunMessage(runID, agentID)
	receipt := verifiedMaterializationReceipt()
	message.Payload.ContextPlan = &contracts.RuntimeContextPlan{
		ResultEvidence: &contracts.TaskResultEvidence{
			ArtifactRefs: []contracts.ArtifactReference{{
				ArtifactID: receipt.ArtifactID,
				Type:       contracts.Patch,
				Content: &contracts.PinnedArtifactContent{
					ContentID: receipt.ContentID, LogicalAlias: receipt.LogicalAlias,
					MediaType: receipt.MediaType, Sha256: receipt.Sha256,
					SizeBytes: receipt.SizeBytes,
				},
			}},
		},
	}
	return message
}

func TestHandlerMaterializesBeforeAcknowledgementAndRuntimeAdmission(t *testing.T) {
	inbox, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 25, 10, 0, 0, 0, time.UTC)
	receipt := verifiedMaterializationReceipt()
	var sent []any
	runtimeStarts := 0
	handler := Handler{
		Inbox: inbox,
		Now:   func() time.Time { return now },
		Prepare: func(
			context.Context,
			contracts.RunRequestedPayload,
		) ([]contracts.VerifiedArtifactMaterializationReceipt, error) {
			return []contracts.VerifiedArtifactMaterializationReceipt{receipt}, nil
		},
		OnNew: func(_ context.Context, record Record, _ Sender) error {
			runtimeStarts++
			if record.State != StateAccepted || len(sent) != 1 {
				t.Fatalf("Runtime admitted before durable materialization ACK: %#v", record)
			}
			return nil
		},
	}
	message := materializationRunMessage("run_prepare_success", "agent_prepare_success")
	if err := handler.Handle(context.Background(), message, func(
		_ context.Context,
		value any,
	) error {
		sent = append(sent, value)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	accepted, ok := sent[0].(contracts.RunAcceptedMessage)
	if !ok || len(accepted.Payload.ArtifactMaterializations) != 1 ||
		accepted.Payload.ArtifactMaterializations[0] != receipt ||
		accepted.Payload.ArtifactMaterializationError != nil || runtimeStarts != 1 {
		t.Fatalf("unexpected materialization ACK: %#v starts=%d", sent[0], runtimeStarts)
	}
}

func TestHandlerKeepsRetryablePreparationPendingAndResumesOnRedelivery(t *testing.T) {
	inbox, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	retryable := errors.New("temporary download interruption")
	prepareCalls := 0
	runtimeStarts := 0
	receipt := verifiedMaterializationReceipt()
	handler := Handler{
		Inbox: inbox,
		Prepare: func(
			context.Context,
			contracts.RunRequestedPayload,
		) ([]contracts.VerifiedArtifactMaterializationReceipt, error) {
			prepareCalls++
			if prepareCalls == 1 {
				return nil, retryable
			}
			return []contracts.VerifiedArtifactMaterializationReceipt{receipt}, nil
		},
		IsPrepareRetryable: func(err error) bool { return errors.Is(err, retryable) },
		OnNew: func(context.Context, Record, Sender) error {
			runtimeStarts++
			return nil
		},
		OnDuplicate: func(context.Context, Record, Sender) error {
			t.Fatal("resumed preparation was treated as an executed duplicate")
			return nil
		},
	}
	message := materializationRunMessage("run_prepare_retryable", "agent_prepare_retryable")
	var sent []any
	send := func(_ context.Context, value any) error {
		sent = append(sent, value)
		return nil
	}
	if err := handler.Handle(context.Background(), message, send); !errors.Is(err, retryable) {
		t.Fatalf("retryable preparation error=%v", err)
	}
	record, err := inbox.Get(message.Payload.RunID)
	if err != nil {
		t.Fatal(err)
	}
	if record.State != StatePreparing || len(sent) != 0 || runtimeStarts != 0 {
		t.Fatalf("retryable preparation was acknowledged or admitted: %#v", record)
	}
	if err := (RuntimeExecutor{Inbox: inbox}).Recover(
		context.Background(),
		send,
	); err != nil {
		t.Fatal(err)
	}
	if len(sent) != 0 {
		t.Fatalf("preparing Run was guessed during reconnect: %#v", sent)
	}
	if err := handler.Handle(context.Background(), message, send); err != nil {
		t.Fatal(err)
	}
	accepted, ok := sent[0].(contracts.RunAcceptedMessage)
	if !ok || len(accepted.Payload.ArtifactMaterializations) != 1 ||
		accepted.Payload.ArtifactMaterializations[0] != receipt || runtimeStarts != 1 {
		t.Fatalf("resumed preparation did not converge: %#v starts=%d", sent, runtimeStarts)
	}
}

func TestHandlerReportsDeterministicMaterializationFailureWithoutRuntime(t *testing.T) {
	inbox, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	executor := RuntimeExecutor{Inbox: inbox}
	runtimeStarts := 0
	handler := Handler{
		Inbox: inbox,
		Prepare: func(
			context.Context,
			contracts.RunRequestedPayload,
		) ([]contracts.VerifiedArtifactMaterializationReceipt, error) {
			return nil, errors.New("digest mismatch")
		},
		IsPrepareRetryable: func(error) bool { return false },
		OnPrepareFailed:    executor.FailMaterialization,
		OnNew: func(context.Context, Record, Sender) error {
			runtimeStarts++
			return nil
		},
	}
	message := materializationRunMessage("run_prepare_failure", "agent_prepare_failure")
	var sent []any
	if err := handler.Handle(context.Background(), message, func(
		_ context.Context,
		value any,
	) error {
		sent = append(sent, value)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(sent) != 2 || runtimeStarts != 0 {
		t.Fatalf("deterministic failure sent=%#v starts=%d", sent, runtimeStarts)
	}
	accepted, ok := sent[0].(contracts.RunAcceptedMessage)
	if !ok || accepted.Payload.ArtifactMaterializationError == nil ||
		accepted.Payload.ArtifactMaterializationError.Code !=
			"ARTIFACT_MATERIALIZATION_FAILED" ||
		accepted.Payload.ArtifactMaterializationError.Retryable ||
		len(accepted.Payload.ArtifactMaterializations) != 0 {
		t.Fatalf("unexpected negative acknowledgement: %#v", sent[0])
	}
	failed, ok := sent[1].(contracts.RunStatusMessage)
	if !ok || failed.Payload.Status != contracts.Failed || failed.Payload.Sequence != 2 ||
		failed.Payload.Error == nil ||
		failed.Payload.Error.Code != "ARTIFACT_MATERIALIZATION_FAILED" {
		t.Fatalf("unexpected terminal materialization failure: %#v", sent[1])
	}
	record, err := inbox.Get(message.Payload.RunID)
	if err != nil {
		t.Fatal(err)
	}
	if record.State != StateFailed || record.LastSequence != 2 {
		t.Fatalf("materialization failure was not durable: %#v", record)
	}
}

func TestHandlerCancelsDuringPreparationWithoutRuntimeOrVerifiedReceipt(t *testing.T) {
	inbox, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	executor := RuntimeExecutor{Inbox: inbox}
	handler := Handler{
		Inbox: inbox,
		Prepare: func(
			context.Context,
			contracts.RunRequestedPayload,
		) ([]contracts.VerifiedArtifactMaterializationReceipt, error) {
			return nil, errors.New("download canceled")
		},
		IsPrepareRetryable: func(error) bool { return true },
		IsExplicitCancel: func(ctx context.Context) bool {
			return errors.Is(context.Cause(ctx), errExplicitTestCancel)
		},
		OnQueuedCanceled: executor.CancelQueued,
		OnNew: func(context.Context, Record, Sender) error {
			t.Fatal("canceled preparation entered Runtime")
			return nil
		},
	}
	ctx, cancel := context.WithCancelCause(context.Background())
	cancel(errExplicitTestCancel)
	var sent []any
	if err := handler.Handle(
		ctx,
		materializationRunMessage("run_prepare_canceled", "agent_prepare_canceled"),
		func(_ context.Context, value any) error {
			sent = append(sent, value)
			return nil
		},
	); err != nil {
		t.Fatal(err)
	}
	if len(sent) != 2 {
		t.Fatalf("preparation cancellation sent %d messages: %#v", len(sent), sent)
	}
	accepted, acceptedOK := sent[0].(contracts.RunAcceptedMessage)
	canceled, canceledOK := sent[1].(contracts.RunStatusMessage)
	if !acceptedOK || !canceledOK ||
		accepted.Payload.ArtifactMaterializationError == nil ||
		len(accepted.Payload.ArtifactMaterializations) != 0 ||
		canceled.Payload.Status != contracts.Canceled || canceled.Payload.Sequence != 2 {
		t.Fatalf("preparation cancellation did not converge: %#v", sent)
	}
}

func TestRuntimeRecoveryReverifiesArtifactReceiptsBeforeAcceptance(t *testing.T) {
	inbox, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	message := materializationRunMessage("run_prepare_recovery", "agent_prepare_recovery")
	if _, _, err := inbox.Accept(message.Payload, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	receipt := verifiedMaterializationReceipt()
	executor := RuntimeExecutor{
		Inbox: inbox,
		Prepare: func(
			context.Context,
			contracts.RunRequestedPayload,
		) ([]contracts.VerifiedArtifactMaterializationReceipt, error) {
			reused := receipt
			reused.MaterializationState = contracts.Reused
			return []contracts.VerifiedArtifactMaterializationReceipt{reused}, nil
		},
	}
	var sent []any
	if err := executor.Recover(context.Background(), func(
		_ context.Context,
		value any,
	) error {
		sent = append(sent, value)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	accepted, ok := sent[0].(contracts.RunAcceptedMessage)
	if !ok || len(accepted.Payload.ArtifactMaterializations) != 1 ||
		accepted.Payload.ArtifactMaterializations[0].MaterializationState != contracts.Reused {
		t.Fatalf("recovery omitted verified receipt: %#v", sent)
	}
}

func TestMaterializationFailureAckLossReplaysDeterministicTerminalState(t *testing.T) {
	inbox, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	failure := errors.New("digest mismatch")
	executor := RuntimeExecutor{Inbox: inbox}
	handler := Handler{
		Inbox: inbox,
		Prepare: func(
			context.Context,
			contracts.RunRequestedPayload,
		) ([]contracts.VerifiedArtifactMaterializationReceipt, error) {
			return nil, failure
		},
		IsPrepareRetryable: func(error) bool { return false },
		OnPrepareFailed:    executor.FailMaterialization,
	}
	message := materializationRunMessage(
		"run_prepare_ack_loss",
		"agent_prepare_ack_loss",
	)
	ackLost := errors.New("acceptance write lost")
	if err := handler.Handle(context.Background(), message, func(
		context.Context,
		any,
	) error {
		return ackLost
	}); !errors.Is(err, ackLost) {
		t.Fatalf("ACK-loss error=%v", err)
	}
	record, err := inbox.Get(message.Payload.RunID)
	if err != nil {
		t.Fatal(err)
	}
	if record.State != StateFailed || record.LastSequence != 2 || len(record.Events) != 1 {
		t.Fatalf("failure was not durable before ACK: %#v", record)
	}
	prepareCalls := 0
	executor.Prepare = func(
		context.Context,
		contracts.RunRequestedPayload,
	) ([]contracts.VerifiedArtifactMaterializationReceipt, error) {
		prepareCalls++
		return []contracts.VerifiedArtifactMaterializationReceipt{
			verifiedMaterializationReceipt(),
		}, nil
	}
	var recovered []any
	if err := executor.Recover(context.Background(), func(
		_ context.Context,
		value any,
	) error {
		recovered = append(recovered, value)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(recovered) != 2 {
		t.Fatalf("recovery sent %d messages: %#v", len(recovered), recovered)
	}
	if prepareCalls != 0 {
		t.Fatalf("terminal materialization failure was retried %d times", prepareCalls)
	}
	accepted, ok := recovered[0].(contracts.RunAcceptedMessage)
	if !ok || accepted.Payload.ArtifactMaterializationError == nil {
		t.Fatalf("recovery omitted negative ACK: %#v", recovered[0])
	}
	raw, ok := recovered[1].(json.RawMessage)
	if !ok {
		t.Fatalf("recovery terminal type=%T", recovered[1])
	}
	var failed contracts.RunStatusMessage
	if err := json.Unmarshal(raw, &failed); err != nil {
		t.Fatal(err)
	}
	if failed.Payload.Status != contracts.Failed || failed.Payload.Sequence != 2 ||
		failed.Payload.Error == nil ||
		failed.Payload.Error.Code != "ARTIFACT_MATERIALIZATION_FAILED" {
		t.Fatalf("recovery changed deterministic failure: %#v", failed)
	}
}

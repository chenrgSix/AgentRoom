package connection

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/delivery"
	"convenewire.dev/bridge/internal/pairing"
	contracts "convenewire.dev/contracts/generated/go"
	"github.com/coder/websocket"
)

func validCancellationRunRequest(now time.Time) contracts.RunRequestedMessage {
	return contracts.RunRequestedMessage{
		ProtocolVersion: "1.0",
		MessageID:       "msg_cancel_replay_request_12345678",
		Timestamp:       now,
		Type:            contracts.RunRequested,
		Payload: contracts.RunRequestedPayload{
			RunID:             "run_cancel_replay_12345678",
			TraceID:           "trace_cancel_replay_12345678",
			RoomID:            "room_cancel_replay_12345678",
			TriggerMessageID:  "msg_cancel_replay_trigger_12345678",
			RequesterMemberID: "member_cancel_replay_12345678",
			TargetAgentID:     "agent_cancel_replay_12345678",
			DeliveryAttemptID: "delivery_cancel_replay_12345678",
			IdempotencyKey:    "idem_cancel_replay_12345678",
			Instruction:       "Complete once without restarting on cancel replay.",
			ContextMessages:   []contracts.ContextMessage{},
			Deadline:          now.Add(time.Minute),
		},
	}
}

func TestCanceledRunReplaysDurableTerminalStatusAfterFirstWriteIsLost(t *testing.T) {
	now := time.Date(2026, time.August, 29, 8, 0, 0, 0, time.UTC)
	directory := t.TempDir()
	inbox, err := delivery.Open(directory + "/inbox")
	if err != nil {
		t.Fatal(err)
	}
	requested := validCancellationRunRequest(now)
	terminal := contracts.RunStatusMessage{
		ProtocolVersion: "1.0",
		MessageID:       "msg_cancel_replay_terminal_12345678",
		Timestamp:       now.Add(time.Second),
		Type:            contracts.RunStatus,
		Payload: contracts.RunStatusPayload{
			RunID:    requested.Payload.RunID,
			TraceID:  requested.Payload.TraceID,
			AgentID:  requested.Payload.TargetAgentID,
			Sequence: 2,
			Status:   contracts.Completed,
		},
	}
	canceled := contracts.RunCancelRequestedMessage{
		ProtocolVersion: "1.0",
		MessageID:       "msg_cancel_replay_signal_12345678",
		Timestamp:       now.Add(2 * time.Second),
		Type:            contracts.RunCancelRequested,
		Payload: contracts.RunCancelRequestedPayload{
			RunID:   requested.Payload.RunID,
			TraceID: requested.Payload.TraceID,
			AgentID: requested.Payload.TargetAgentID,
			Reason:  "Central did not observe the first terminal status",
		},
	}

	firstTerminal := make(chan []byte, 1)
	replayedTerminal := make(chan []byte, 1)
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		socket, acceptErr := websocket.Accept(response, request, nil)
		if acceptErr != nil {
			return
		}
		defer socket.CloseNow()
		for index := 0; index < 2; index++ {
			if _, _, readErr := socket.Read(request.Context()); readErr != nil {
				return
			}
		}
		source, _ := json.Marshal(requested)
		if writeErr := socket.Write(
			request.Context(), websocket.MessageText, source,
		); writeErr != nil {
			return
		}
		_, source, readErr := socket.Read(request.Context())
		if readErr != nil {
			return
		}
		firstTerminal <- append([]byte(nil), source...)
		// The first write reached the transport but is deliberately treated as
		// lost by Central. Give the Run worker time to leave the active map.
		time.Sleep(100 * time.Millisecond)
		source, _ = json.Marshal(canceled)
		if writeErr := socket.Write(
			request.Context(), websocket.MessageText, source,
		); writeErr != nil {
			return
		}
		_, source, readErr = socket.Read(request.Context())
		if readErr != nil {
			return
		}
		replayedTerminal <- append([]byte(nil), source...)
		<-request.Context().Done()
	}))
	defer server.Close()

	executor := delivery.RuntimeExecutor{Inbox: inbox}
	var handleCalls int
	client := Client{
		Config: config.Config{
			ServerURL: server.URL,
			DataDir:   directory,
			Agents: []config.AgentConfig{{
				Name: "Builder", Role: "Implementation", Adapter: "generic",
				Command: []string{"agent"}, Workspace: directory,
			}},
		},
		Credential: pairing.Credential{
			ServerURL: server.URL, DeviceID: "device_cancel_replay_12345678",
			TeamID:        "team_cancel_replay_12345678",
			OwnerMemberID: "member_cancel_replay_12345678", Token: "device-secret",
		},
		HeartbeatInterval: time.Second,
		HandleRun: func(
			ctx context.Context,
			message contracts.RunRequestedMessage,
			send func(context.Context, any) error,
		) error {
			handleCalls++
			record, duplicate, acceptErr := inbox.Accept(message.Payload, now)
			if acceptErr != nil {
				return acceptErr
			}
			if duplicate {
				return errors.New("initial Run request was unexpectedly duplicate")
			}
			if _, appendErr := inbox.AppendEvent(
				record.RunID,
				delivery.StateCompleted,
				terminal.Payload.Sequence,
				terminal,
				now.Add(time.Second),
			); appendErr != nil {
				return appendErr
			}
			return send(ctx, terminal)
		},
		ReplayCanceledRun: func(
			ctx context.Context,
			message contracts.RunCancelRequestedMessage,
			send func(context.Context, any) error,
		) error {
			return executor.ReplayCanceledRun(ctx, message, delivery.Sender(send))
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- client.Run(ctx) }()

	var first, replay []byte
	select {
	case first = <-firstTerminal:
	case <-time.After(2 * time.Second):
		cancel()
		t.Fatal("timed out waiting for the first terminal status")
	}
	select {
	case replay = <-replayedTerminal:
	case <-time.After(2 * time.Second):
		cancel()
		t.Fatal("timed out waiting for cancellation terminal replay")
	}
	if string(replay) != string(first) {
		t.Fatalf("terminal replay changed payload:\nfirst=%s\nreplay=%s", first, replay)
	}
	if handleCalls != 1 {
		t.Fatalf("cancellation replay restarted the Runtime %d times", handleCalls)
	}
	latest, err := inbox.Get(requested.Payload.RunID)
	if err != nil || latest.State != delivery.StateCompleted ||
		latest.LastSequence != terminal.Payload.Sequence {
		t.Fatalf("durable terminal record changed during replay: %#v err=%v", latest, err)
	}
	cancel()
	select {
	case runErr := <-done:
		if runErr != nil {
			t.Fatal(runErr)
		}
	case <-time.After(time.Second):
		t.Fatal("Bridge client did not stop")
	}
}

func TestCancelDuringBlockedPreparationDoesNotStartRuntime(t *testing.T) {
	handled := make(chan error, 1)
	now := time.Date(2026, time.August, 29, 8, 30, 0, 0, time.UTC)
	directory := t.TempDir()
	inbox, err := delivery.Open(directory + "/inbox")
	if err != nil {
		t.Fatal(err)
	}
	requested := validCancellationRunRequest(now)
	canceled := contracts.RunCancelRequestedMessage{
		ProtocolVersion: "1.0",
		MessageID:       "msg_cancel_prepare_signal_12345678",
		Timestamp:       now.Add(time.Second),
		Type:            contracts.RunCancelRequested,
		Payload: contracts.RunCancelRequestedPayload{
			RunID:   requested.Payload.RunID,
			TraceID: requested.Payload.TraceID,
			AgentID: requested.Payload.TargetAgentID,
			Reason:  "Cancel before preparation admits the Runtime",
		},
	}

	prepareStarted := make(chan struct{})
	received := make(chan [][]byte, 1)
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		socket, acceptErr := websocket.Accept(response, request, nil)
		if acceptErr != nil {
			return
		}
		defer socket.CloseNow()
		for index := 0; index < 2; index++ {
			if _, _, readErr := socket.Read(request.Context()); readErr != nil {
				return
			}
		}
		source, _ := json.Marshal(requested)
		if writeErr := socket.Write(
			request.Context(), websocket.MessageText, source,
		); writeErr != nil {
			return
		}
		select {
		case <-prepareStarted:
		case <-request.Context().Done():
			return
		}
		source, _ = json.Marshal(canceled)
		if writeErr := socket.Write(
			request.Context(), websocket.MessageText, source,
		); writeErr != nil {
			return
		}
		events := make([][]byte, 0, 2)
		for index := 0; index < 2; index++ {
			_, source, readErr := socket.Read(request.Context())
			if readErr != nil {
				return
			}
			events = append(events, append([]byte(nil), source...))
		}
		received <- events
		<-request.Context().Done()
	}))
	defer server.Close()

	executor := delivery.RuntimeExecutor{Inbox: inbox, Now: func() time.Time { return now }}
	var runtimeStarts atomic.Int32
	handler := delivery.Handler{
		Inbox: inbox,
		Prepare: func(
			ctx context.Context,
			_ contracts.RunRequestedPayload,
		) ([]contracts.VerifiedArtifactMaterializationReceipt, error) {
			close(prepareStarted)
			<-ctx.Done()
			return nil, context.Cause(ctx)
		},
		IsPrepareRetryable: func(error) bool { return true },
		IsExplicitCancel: func(ctx context.Context) bool {
			return errors.Is(context.Cause(ctx), ErrRunCancelRequested)
		},
		OnQueuedCanceled: executor.CancelQueued,
		OnNew: func(context.Context, delivery.Record, delivery.Sender) error {
			runtimeStarts.Add(1)
			return nil
		},
		Now: func() time.Time { return now },
	}
	client := Client{
		Config: config.Config{
			ServerURL: server.URL,
			DataDir:   directory,
			Agents: []config.AgentConfig{{
				Name: "Builder", Role: "Implementation", Adapter: "generic",
				Command: []string{"agent"}, Workspace: directory,
			}},
		},
		Credential: pairing.Credential{
			ServerURL: server.URL, DeviceID: "device_cancel_prepare_12345678",
			TeamID:        "team_cancel_prepare_12345678",
			OwnerMemberID: "member_cancel_prepare_12345678", Token: "device-secret",
		},
		HeartbeatInterval: time.Hour,
		HandleRun: func(
			ctx context.Context,
			message contracts.RunRequestedMessage,
			send func(context.Context, any) error,
		) error {
			err := handler.Handle(ctx, message, delivery.Sender(send))
			handled <- err
			return err
		},
		FenceCanceledRun: func(message contracts.RunCancelRequestedMessage) error {
			return executor.StageCancellation(message)
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- client.Run(ctx) }()

	var events [][]byte
	select {
	case events = <-received:
	case <-time.After(2 * time.Second):
		cancel()
		t.Fatal("timed out waiting for preparation cancellation acknowledgement")
	}
	waitCancellationHandler(t, handled)
	var accepted contracts.RunAcceptedMessage
	if err := json.Unmarshal(events[0], &accepted); err != nil {
		t.Fatal(err)
	}
	var terminal contracts.RunStatusMessage
	if err := json.Unmarshal(events[1], &terminal); err != nil {
		t.Fatal(err)
	}
	if accepted.Type != contracts.RunAccepted ||
		accepted.Payload.RunID != requested.Payload.RunID ||
		accepted.Payload.TraceID != requested.Payload.TraceID ||
		accepted.Payload.AgentID != requested.Payload.TargetAgentID ||
		terminal.Type != contracts.RunStatus ||
		terminal.Payload.RunID != requested.Payload.RunID ||
		terminal.Payload.TraceID != requested.Payload.TraceID ||
		terminal.Payload.AgentID != requested.Payload.TargetAgentID ||
		terminal.Payload.Sequence != 2 || terminal.Payload.Status != contracts.Canceled {
		t.Fatalf("preparation cancellation lost Run identity: accepted=%#v terminal=%#v", accepted, terminal)
	}
	if runtimeStarts.Load() != 0 {
		t.Fatalf("canceled preparation started Runtime %d times", runtimeStarts.Load())
	}
	record, err := inbox.Get(requested.Payload.RunID)
	if err != nil || record.State != delivery.StateCanceled || record.LastSequence != 2 {
		t.Fatalf("preparation cancellation was not durable: %#v err=%v", record, err)
	}
	staged, err := inbox.HasCancellation(requested.Payload)
	if err != nil || staged {
		t.Fatalf("preparation cancellation retained tombstone=%t err=%v", staged, err)
	}

	cancel()
	select {
	case runErr := <-done:
		if runErr != nil {
			t.Fatal(runErr)
		}
	case <-time.After(time.Second):
		t.Fatal("Bridge client did not stop")
	}
}

func TestPreAdmissionCancellationAcknowledgesWithoutStartingRuntime(t *testing.T) {
	handled := make(chan error, 1)
	now := time.Date(2026, time.August, 29, 8, 45, 0, 0, time.UTC)
	directory := t.TempDir()
	inbox, err := delivery.Open(directory + "/inbox")
	if err != nil {
		t.Fatal(err)
	}
	requested := validCancellationRunRequest(now)
	canceled := contracts.RunCancelRequestedMessage{
		ProtocolVersion: "1.0",
		MessageID:       "msg_cancel_tombstone_signal_12345678",
		Timestamp:       now.Add(time.Second),
		Type:            contracts.RunCancelRequested,
		Payload: contracts.RunCancelRequestedPayload{
			RunID:   requested.Payload.RunID,
			TraceID: requested.Payload.TraceID,
			AgentID: requested.Payload.TargetAgentID,
			Reason:  "Fence Runtime admission before request replay",
		},
	}

	received := make(chan [][]byte, 1)
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		socket, acceptErr := websocket.Accept(response, request, nil)
		if acceptErr != nil {
			return
		}
		defer socket.CloseNow()
		for index := 0; index < 2; index++ {
			if _, _, readErr := socket.Read(request.Context()); readErr != nil {
				return
			}
		}
		cancelSource, _ := json.Marshal(canceled)
		if writeErr := socket.Write(
			request.Context(), websocket.MessageText, cancelSource,
		); writeErr != nil {
			return
		}
		events := make([][]byte, 0, 1)
		for index := 0; index < 1; index++ {
			_, source, readErr := socket.Read(request.Context())
			if readErr != nil {
				return
			}
			events = append(events, append([]byte(nil), source...))
		}
		received <- events
		<-request.Context().Done()
	}))
	defer server.Close()

	executor := delivery.RuntimeExecutor{Inbox: inbox, Now: func() time.Time { return now }}
	var runtimeStarts atomic.Int32
	handler := delivery.Handler{
		Inbox:            inbox,
		OnQueuedCanceled: executor.CancelQueued,
		OnNew: func(context.Context, delivery.Record, delivery.Sender) error {
			runtimeStarts.Add(1)
			return nil
		},
		Now: func() time.Time { return now },
	}
	client := Client{
		Config: config.Config{
			ServerURL: server.URL,
			DataDir:   directory,
			Agents: []config.AgentConfig{{
				Name: "Builder", Role: "Implementation", Adapter: "generic",
				Command: []string{"agent"}, Workspace: directory,
			}},
		},
		Credential: pairing.Credential{
			ServerURL: server.URL, DeviceID: "device_cancel_tombstone_12345678",
			TeamID:        "team_cancel_tombstone_12345678",
			OwnerMemberID: "member_cancel_tombstone_12345678", Token: "device-secret",
		},
		HeartbeatInterval: time.Hour,
		HandleRun: func(
			ctx context.Context,
			message contracts.RunRequestedMessage,
			send func(context.Context, any) error,
		) error {
			return handler.Handle(ctx, message, delivery.Sender(send))
		},
		ReplayCanceledRun: func(
			ctx context.Context,
			message contracts.RunCancelRequestedMessage,
			send func(context.Context, any) error,
		) error {
			err := executor.ReplayCanceledRun(ctx, message, delivery.Sender(send))
			handled <- err
			return err
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- client.Run(ctx) }()

	var events [][]byte
	select {
	case events = <-received:
	case <-time.After(2 * time.Second):
		cancel()
		t.Fatal("timed out waiting for tombstoned cancellation result")
	}
	waitCancellationHandler(t, handled)
	var tombstoneAck contracts.RunStatusMessage
	if err := json.Unmarshal(events[0], &tombstoneAck); err != nil {
		t.Fatal(err)
	}
	if tombstoneAck.Type != contracts.RunStatus ||
		tombstoneAck.Payload.RunID != requested.Payload.RunID ||
		tombstoneAck.Payload.TraceID != requested.Payload.TraceID ||
		tombstoneAck.Payload.Sequence != 1 ||
		tombstoneAck.Payload.Status != contracts.Canceled {
		t.Fatalf(
			"pre-admission cancellation lost Run identity: ack=%#v",
			tombstoneAck,
		)
	}
	if runtimeStarts.Load() != 0 {
		t.Fatalf("tombstoned cancellation started Runtime %d times", runtimeStarts.Load())
	}
	record, err := inbox.Get(requested.Payload.RunID)
	if !os.IsNotExist(err) {
		t.Fatalf("pre-admission cancellation created Run record: %#v err=%v", record, err)
	}
	staged, err := inbox.HasCancellation(requested.Payload)
	if err != nil || staged {
		t.Fatalf("completed cancellation retained tombstone=%t err=%v", staged, err)
	}

	cancel()
	select {
	case runErr := <-done:
		if runErr != nil {
			t.Fatal(runErr)
		}
	case <-time.After(time.Second):
		t.Fatal("Bridge client did not stop")
	}
}

func TestActiveWorkerStagesCancellationBeforeInboxAdmission(t *testing.T) {
	handled := make(chan error, 1)
	now := time.Date(2026, time.August, 29, 8, 55, 0, 0, time.UTC)
	directory := t.TempDir()
	inbox, err := delivery.Open(directory + "/inbox")
	if err != nil {
		t.Fatal(err)
	}
	requested := validCancellationRunRequest(now)
	canceled := contracts.RunCancelRequestedMessage{
		ProtocolVersion: "1.0",
		MessageID:       "msg_cancel_active_fence_12345678",
		Timestamp:       now.Add(time.Second),
		Type:            contracts.RunCancelRequested,
		Payload: contracts.RunCancelRequestedPayload{
			RunID: requested.Payload.RunID, TraceID: requested.Payload.TraceID,
			AgentID: requested.Payload.TargetAgentID,
			Reason:  "Fence a scheduled worker before durable admission",
		},
	}
	workerScheduled := make(chan struct{})
	workerRelease := make(chan struct{})
	fencePersisted := make(chan struct{})
	received := make(chan [][]byte, 1)
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		socket, acceptErr := websocket.Accept(response, request, nil)
		if acceptErr != nil {
			return
		}
		defer socket.CloseNow()
		for index := 0; index < 2; index++ {
			if _, _, readErr := socket.Read(request.Context()); readErr != nil {
				return
			}
		}
		requestSource, _ := json.Marshal(requested)
		if writeErr := socket.Write(
			request.Context(), websocket.MessageText, requestSource,
		); writeErr != nil {
			return
		}
		select {
		case <-workerScheduled:
		case <-request.Context().Done():
			return
		}
		cancelSource, _ := json.Marshal(canceled)
		if writeErr := socket.Write(
			request.Context(), websocket.MessageText, cancelSource,
		); writeErr != nil {
			return
		}
		select {
		case <-fencePersisted:
			close(workerRelease)
		case <-request.Context().Done():
			return
		}
		events := make([][]byte, 0, 2)
		for index := 0; index < 2; index++ {
			_, source, readErr := socket.Read(request.Context())
			if readErr != nil {
				return
			}
			events = append(events, append([]byte(nil), source...))
		}
		received <- events
		<-request.Context().Done()
	}))
	defer server.Close()

	executor := delivery.RuntimeExecutor{Inbox: inbox, Now: func() time.Time { return now }}
	var runtimeStarts atomic.Int32
	handler := delivery.Handler{
		Inbox:            inbox,
		OnQueuedCanceled: executor.CancelQueued,
		OnNew: func(context.Context, delivery.Record, delivery.Sender) error {
			runtimeStarts.Add(1)
			return nil
		},
		IsExplicitCancel: func(ctx context.Context) bool {
			return errors.Is(context.Cause(ctx), ErrRunCancelRequested)
		},
		Now: func() time.Time { return now },
	}
	client := Client{
		Config: config.Config{
			ServerURL: server.URL, DataDir: directory,
			Agents: []config.AgentConfig{{
				Name: "Builder", Role: "Implementation", Adapter: "generic",
				Command: []string{"agent"}, Workspace: directory,
			}},
		},
		Credential: pairing.Credential{
			ServerURL: server.URL, DeviceID: "device_cancel_active_fence_12345678",
			TeamID:        "team_cancel_active_fence_12345678",
			OwnerMemberID: "member_cancel_active_fence_12345678", Token: "secret",
		},
		HeartbeatInterval: time.Hour,
		HandleRun: func(
			ctx context.Context,
			message contracts.RunRequestedMessage,
			send func(context.Context, any) error,
		) error {
			close(workerScheduled)
			<-workerRelease
			err := handler.Handle(ctx, message, delivery.Sender(send))
			handled <- err
			return err
		},
		FenceCanceledRun: func(message contracts.RunCancelRequestedMessage) error {
			err := executor.StageCancellation(message)
			close(fencePersisted)
			return err
		},
		ReplayCanceledRun: func(
			ctx context.Context,
			message contracts.RunCancelRequestedMessage,
			send func(context.Context, any) error,
		) error {
			return executor.ReplayCanceledRun(ctx, message, delivery.Sender(send))
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- client.Run(ctx) }()

	var events [][]byte
	select {
	case events = <-received:
	case <-time.After(2 * time.Second):
		cancel()
		t.Fatal("timed out waiting for active cancellation fence")
	}
	waitCancellationHandler(t, handled)
	var accepted contracts.RunAcceptedMessage
	if err := json.Unmarshal(events[0], &accepted); err != nil {
		t.Fatal(err)
	}
	var terminal contracts.RunStatusMessage
	if err := json.Unmarshal(events[1], &terminal); err != nil {
		t.Fatal(err)
	}
	if accepted.Type != contracts.RunAccepted ||
		accepted.Payload.RunID != requested.Payload.RunID ||
		terminal.Type != contracts.RunStatus ||
		terminal.Payload.RunID != requested.Payload.RunID ||
		terminal.Payload.Sequence != 2 || terminal.Payload.Status != contracts.Canceled {
		t.Fatalf("active cancellation fence emitted invalid result: %#v %#v", accepted, terminal)
	}
	if runtimeStarts.Load() != 0 {
		t.Fatalf("scheduled canceled worker started Runtime %d times", runtimeStarts.Load())
	}
	record, err := inbox.Get(requested.Payload.RunID)
	if err != nil || record.State != delivery.StateCanceled || record.LastSequence != 2 {
		t.Fatalf("active cancellation fence was not durable: %#v err=%v", record, err)
	}
	staged, err := inbox.HasCancellation(requested.Payload)
	if err != nil || staged {
		t.Fatalf("active cancellation fence retained tombstone=%t err=%v", staged, err)
	}

	cancel()
	select {
	case runErr := <-done:
		if runErr != nil {
			t.Fatal(runErr)
		}
	case <-time.After(time.Second):
		t.Fatal("Bridge client did not stop")
	}
}

// Receiving the terminal WebSocket frame precedes the sender returning and
// clearing its durable cancellation fence. Inspect cleanup only after the
// production callback completes, retaining the send-before-clear guarantee.
func waitCancellationHandler(t *testing.T, handled <-chan error) {
	t.Helper()
	select {
	case err := <-handled:
		if err != nil {
			t.Fatalf("cancellation handler failed: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancellation handler did not finish cleanup")
	}
}

func TestActiveRunCancellationIdentityMismatchFailsClosed(t *testing.T) {
	now := time.Date(2026, time.August, 29, 9, 0, 0, 0, time.UTC)
	for _, mismatch := range []string{"trace", "agent"} {
		t.Run(mismatch, func(t *testing.T) {
			requested := validCancellationRunRequest(now)
			canceled := contracts.RunCancelRequestedMessage{
				ProtocolVersion: "1.0",
				MessageID:       "msg_cancel_mismatch_signal_12345678",
				Timestamp:       now.Add(time.Second),
				Type:            contracts.RunCancelRequested,
				Payload: contracts.RunCancelRequestedPayload{
					RunID: requested.Payload.RunID, TraceID: requested.Payload.TraceID,
					AgentID: requested.Payload.TargetAgentID, Reason: "mismatch test",
				},
			}
			if mismatch == "trace" {
				canceled.Payload.TraceID = "trace_cancel_mismatch_12345678"
			} else {
				canceled.Payload.AgentID = "agent_cancel_mismatch_12345678"
			}
			handlerReady := make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(
				response http.ResponseWriter,
				request *http.Request,
			) {
				socket, acceptErr := websocket.Accept(response, request, nil)
				if acceptErr != nil {
					return
				}
				defer socket.CloseNow()
				for index := 0; index < 2; index++ {
					if _, _, readErr := socket.Read(request.Context()); readErr != nil {
						return
					}
				}
				source, _ := json.Marshal(requested)
				if writeErr := socket.Write(
					request.Context(), websocket.MessageText, source,
				); writeErr != nil {
					return
				}
				select {
				case <-handlerReady:
				case <-request.Context().Done():
					return
				}
				source, _ = json.Marshal(canceled)
				_ = socket.Write(request.Context(), websocket.MessageText, source)
				<-request.Context().Done()
			}))
			defer server.Close()

			var replayCalls atomic.Int32
			cause := make(chan error, 1)
			directory := t.TempDir()
			client := Client{
				Config: config.Config{
					ServerURL: server.URL, DataDir: directory,
					Agents: []config.AgentConfig{{
						Name: "Builder", Role: "Implementation", Adapter: "generic",
						Command: []string{"agent"}, Workspace: directory,
					}},
				},
				Credential: pairing.Credential{
					ServerURL: server.URL, DeviceID: "device_cancel_mismatch_12345678",
					TeamID:        "team_cancel_mismatch_12345678",
					OwnerMemberID: "member_cancel_mismatch_12345678", Token: "secret",
				},
				HandleRun: func(
					ctx context.Context,
					_ contracts.RunRequestedMessage,
					_ func(context.Context, any) error,
				) error {
					close(handlerReady)
					<-ctx.Done()
					cause <- context.Cause(ctx)
					return nil
				},
				ReplayCanceledRun: func(
					context.Context,
					contracts.RunCancelRequestedMessage,
					func(context.Context, any) error,
				) error {
					replayCalls.Add(1)
					return nil
				},
			}
			connected, err := client.connectOnce(context.Background())
			if !connected || err == nil || !strings.Contains(err.Error(), "identity mismatch") {
				t.Fatalf("connectOnce connected=%t error=%v", connected, err)
			}
			if replayCalls.Load() != 0 {
				t.Fatal("mismatched active cancellation reached durable replay")
			}
			select {
			case cancellationCause := <-cause:
				if errors.Is(cancellationCause, ErrRunCancelRequested) {
					t.Fatal("mismatched cancellation interrupted the active Runtime")
				}
			case <-time.After(time.Second):
				t.Fatal("active Run worker did not drain")
			}
		})
	}
}

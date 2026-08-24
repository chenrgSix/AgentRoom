package bridgecore

import (
	"context"
	"errors"
	"path/filepath"

	"agentroom.dev/bridge/internal/config"
	"agentroom.dev/bridge/internal/connection"
	"agentroom.dev/bridge/internal/delivery"
	"agentroom.dev/bridge/internal/identity"
	"agentroom.dev/bridge/internal/operations"
	"agentroom.dev/bridge/internal/pairing"
	bridgeruntime "agentroom.dev/bridge/internal/runtime"
	contracts "agentroom.dev/contracts/generated/go"
)

// Run starts one managed Bridge connection and blocks until the context ends.
// Both CLI and desktop shells call this function so delivery and Runtime
// semantics cannot drift between launch modes.
func Run(
	ctx context.Context,
	loaded config.Config,
	credential pairing.Credential,
	bridgeVersion string,
) error {
	return RunObserved(ctx, loaded, credential, bridgeVersion, operations.Observer{})
}

// RunObserved starts one managed Bridge connection and reports local-only
// connection and Runtime lifecycle events to the supplied observer.
func RunObserved(
	ctx context.Context,
	loaded config.Config,
	credential pairing.Credential,
	bridgeVersion string,
	observer operations.Observer,
) error {
	inbox, err := delivery.Open(filepath.Join(loaded.DataDir, "inbox"))
	if err != nil {
		return err
	}
	identities, err := identity.LoadOrCreate(loaded.DataDir, loaded.Agents)
	if err != nil {
		return err
	}
	adapters := make(map[string]bridgeruntime.Adapter, len(loaded.Agents))
	agentNames := make(map[string]string, len(loaded.Agents))
	for _, configured := range loaded.Agents {
		agentID := identities[configured.Name]
		agentNames[agentID] = configured.Name
		if configured.RuntimeKind == "pi" {
			adapters[agentID] = bridgeruntime.PiAdapter{Config: configured}
			continue
		}
		switch configured.Adapter {
		case "generic":
			adapters[agentID] = bridgeruntime.GenericAdapter{Config: configured}
		case "codex":
			adapters[agentID] = bridgeruntime.CodexAdapter{Config: configured}
		}
	}
	runtimeObserver := observer
	runtimeObserver.OnRuntime = func(event operations.RuntimeEvent) {
		event.AgentName = agentNames[event.AgentID]
		observer.Runtime(event)
	}
	executor := delivery.RuntimeExecutor{Inbox: inbox, Adapters: adapters, Observer: runtimeObserver}
	runHandler := delivery.Handler{
		Inbox: inbox, Gate: delivery.NewAgentExecutionGate(),
		OnNew: executor.Execute, OnDuplicate: executor.Replay,
		OnQueuedCanceled: executor.CancelQueued,
		IsExplicitCancel: func(ctx context.Context) bool {
			return errors.Is(context.Cause(ctx), connection.ErrRunCancelRequested)
		},
	}
	return (connection.Client{
		Config: loaded, Credential: credential, BridgeVersion: bridgeVersion, Observer: observer,
		RecoverRuns: func(ctx context.Context, send func(context.Context, any) error) error {
			return executor.Recover(ctx, delivery.Sender(send))
		},
		HandleRun: func(ctx context.Context, message contracts.RunRequestedMessage, send func(context.Context, any) error) error {
			return runHandler.Handle(ctx, message, delivery.Sender(send))
		},
	}).Run(ctx)
}

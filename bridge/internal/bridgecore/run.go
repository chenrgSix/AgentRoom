package bridgecore

import (
	"context"
	"errors"
	"path/filepath"

	bridgeartifact "convenewire.dev/bridge/internal/artifact"
	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/connection"
	"convenewire.dev/bridge/internal/delivery"
	"convenewire.dev/bridge/internal/identity"
	"convenewire.dev/bridge/internal/operations"
	"convenewire.dev/bridge/internal/ownership"
	"convenewire.dev/bridge/internal/pairing"
	bridgeruntime "convenewire.dev/bridge/internal/runtime"
	contracts "convenewire.dev/contracts/generated/go"
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
	return RunObservedWithProvisioning(
		ctx, loaded, credential, bridgeVersion, observer, nil,
	)
}

// RunObservedWithProvisioning keeps central requests behind a handler owned by
// the local Console. The connection layer can transport a request but cannot
// mutate Runtime configuration by itself.
func RunObservedWithProvisioning(
	ctx context.Context,
	loaded config.Config,
	credential pairing.Credential,
	bridgeVersion string,
	observer operations.Observer,
	handleProvision connection.ProvisionHandler,
) error {
	ownedContext, releaseOwner, err := ownership.AcquireContext(ctx, loaded.DataDir)
	if err != nil {
		return err
	}
	defer releaseOwner()
	ctx = ownedContext
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
	resumeAgentNames := make(map[string]bool, len(loaded.Agents))
	streamingAgentNames := make(map[string]bool, len(loaded.Agents))
	roomContextCoverageAgentNames := make(map[string]bool, len(loaded.Agents))
	artifactMaterializationAgentNames := make(map[string]bool, len(loaded.Agents))
	sessions := bridgeruntime.NewFileRuntimeSessionStore(loaded.DataDir)
	for _, configured := range loaded.Agents {
		agentID := identities[configured.Name]
		agentNames[agentID] = configured.Name
		if configured.RuntimeKind == "pi" {
			adapters[agentID] = bridgeruntime.PiAdapter{
				Config: configured, Sessions: sessions,
			}
		} else {
			switch configured.Adapter {
			case "generic":
				adapters[agentID] = bridgeruntime.GenericAdapter{Config: configured}
			case "codex":
				adapters[agentID] = bridgeruntime.CodexAdapter{
					Config: configured, Sessions: sessions,
				}
			}
		}
		if adapters[agentID] != nil {
			resumeAgentNames[configured.Name] = adapters[agentID].Capabilities().SupportsResume
			streamingAgentNames[configured.Name] = adapters[agentID].Capabilities().SupportsStreaming
			roomContextCoverageAgentNames[configured.Name] =
				adapters[agentID].Capabilities().SupportsRoomContextCoverage
			artifactMaterializationAgentNames[configured.Name] = true
		}
	}
	materializer := bridgeartifact.NewMaterializer(loaded, credential, identities)
	runtimeObserver := observer
	runtimeObserver.OnRuntime = func(event operations.RuntimeEvent) {
		event.AgentName = agentNames[event.AgentID]
		observer.Runtime(event)
	}
	executor := delivery.RuntimeExecutor{
		Inbox: inbox, Adapters: adapters, Observer: runtimeObserver,
		ShareReasoningSummaries: loaded.ShareReasoningSummaries,
		Prepare:                 materializer.Materialize,
		ResolveArtifacts:        materializer.RuntimeArtifacts,
		IsPrepareRetryable:      bridgeartifact.IsRetryableMaterialization,
	}
	runHandler := delivery.Handler{
		Inbox: inbox, Gate: delivery.NewAgentExecutionGate(),
		OnNew: executor.Execute, OnDuplicate: executor.Replay,
		OnQueuedCanceled:   executor.CancelQueued,
		Prepare:            materializer.Materialize,
		OnPrepareFailed:    executor.FailMaterialization,
		IsPrepareRetryable: bridgeartifact.IsRetryableMaterialization,
		IsExplicitCancel: func(ctx context.Context) bool {
			return errors.Is(context.Cause(ctx), connection.ErrRunCancelRequested)
		},
	}
	return (connection.Client{
		Config: loaded, Credential: credential, BridgeVersion: bridgeVersion, Observer: observer,
		HandleProvision:  handleProvision,
		ResumeAgentNames: resumeAgentNames, StreamingAgentNames: streamingAgentNames,
		RoomContextCoverageAgentNames:     roomContextCoverageAgentNames,
		ArtifactMaterializationAgentNames: artifactMaterializationAgentNames,
		RecoverRuns: func(ctx context.Context, send func(context.Context, any) error) error {
			return executor.Recover(ctx, delivery.Sender(send))
		},
		ReplayCanceledRun: func(
			ctx context.Context,
			message contracts.RunCancelRequestedMessage,
			send func(context.Context, any) error,
		) error {
			return executor.ReplayCanceledRun(ctx, message, delivery.Sender(send))
		},
		FenceCanceledRun: func(message contracts.RunCancelRequestedMessage) error {
			return executor.StageCancellation(message)
		},
		HandleRun: func(ctx context.Context, message contracts.RunRequestedMessage, send func(context.Context, any) error) error {
			return runHandler.Handle(ctx, message, delivery.Sender(send))
		},
	}).Run(ctx)
}

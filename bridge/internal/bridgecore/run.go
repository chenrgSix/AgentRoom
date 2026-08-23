package bridgecore

import (
	"context"
	"path/filepath"

	"agentroom.dev/bridge/internal/config"
	"agentroom.dev/bridge/internal/connection"
	"agentroom.dev/bridge/internal/delivery"
	"agentroom.dev/bridge/internal/identity"
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
	inbox, err := delivery.Open(filepath.Join(loaded.DataDir, "inbox"))
	if err != nil {
		return err
	}
	identities, err := identity.LoadOrCreate(loaded.DataDir, loaded.Agents)
	if err != nil {
		return err
	}
	adapters := make(map[string]bridgeruntime.Adapter, len(loaded.Agents))
	for _, configured := range loaded.Agents {
		switch configured.Adapter {
		case "generic":
			adapters[identities[configured.Name]] = bridgeruntime.GenericAdapter{Config: configured}
		case "codex":
			adapters[identities[configured.Name]] = bridgeruntime.CodexAdapter{Config: configured}
		}
	}
	executor := delivery.RuntimeExecutor{Inbox: inbox, Adapters: adapters}
	runHandler := delivery.Handler{
		Inbox: inbox, OnNew: executor.Execute, OnDuplicate: executor.Replay,
	}
	return (connection.Client{
		Config: loaded, Credential: credential, BridgeVersion: bridgeVersion,
		RecoverRuns: func(ctx context.Context, send func(context.Context, any) error) error {
			return executor.Recover(ctx, delivery.Sender(send))
		},
		HandleRun: func(ctx context.Context, message contracts.RunRequestedMessage, send func(context.Context, any) error) error {
			return runHandler.Handle(ctx, message, delivery.Sender(send))
		},
	}).Run(ctx)
}

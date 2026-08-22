package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"agentroom.dev/bridge/internal/config"
	"agentroom.dev/bridge/internal/connection"
	"agentroom.dev/bridge/internal/delivery"
	"agentroom.dev/bridge/internal/identity"
	"agentroom.dev/bridge/internal/pairing"
	bridgeruntime "agentroom.dev/bridge/internal/runtime"
	contracts "agentroom.dev/contracts/generated/go"
)

const version = "0.1.0"

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "agentroom-bridge:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("expected one of: version, validate-config, pair, run")
	}
	switch args[0] {
	case "version":
		fmt.Println(version)
		return nil
	case "validate-config":
		command := flag.NewFlagSet("validate-config", flag.ContinueOnError)
		path := command.String("config", "", "path to bridge JSON configuration")
		if err := command.Parse(args[1:]); err != nil {
			return err
		}
		resolved := *path
		if resolved == "" {
			resolved = config.DefaultPath()
		}
		loaded, err := config.Load(resolved)
		if err != nil {
			return err
		}
		fmt.Printf("valid bridge config: %s (%d agent(s))\n", resolved, len(loaded.Agents))
		return nil
	case "pair":
		command := flag.NewFlagSet("pair", flag.ContinueOnError)
		path := command.String("config", "", "path to bridge JSON configuration")
		code := command.String("code", "", "one-time pairing code")
		if err := command.Parse(args[1:]); err != nil {
			return err
		}
		if *code == "" {
			return fmt.Errorf("pair requires --code")
		}
		resolved := *path
		if resolved == "" {
			resolved = config.DefaultPath()
		}
		loaded, err := config.Load(resolved)
		if err != nil {
			return err
		}
		credential, err := pairing.Exchange(context.Background(), loaded, *code)
		if err != nil {
			return err
		}
		fmt.Printf("paired device %s with Team %s\n", credential.DeviceID, credential.TeamID)
		return nil
	case "run":
		command := flag.NewFlagSet("run", flag.ContinueOnError)
		path := command.String("config", "", "path to bridge JSON configuration")
		if err := command.Parse(args[1:]); err != nil {
			return err
		}
		resolved := *path
		if resolved == "" {
			resolved = config.DefaultPath()
		}
		loaded, err := config.Load(resolved)
		if err != nil {
			return err
		}
		credential, err := pairing.Load(loaded.DataDir)
		if err != nil {
			return err
		}
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
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
			if configured.Adapter == "generic" {
				adapters[identities[configured.Name]] = bridgeruntime.GenericAdapter{Config: configured}
			}
		}
		executor := delivery.RuntimeExecutor{Inbox: inbox, Adapters: adapters}
		runHandler := delivery.Handler{
			Inbox: inbox, OnNew: executor.Execute, OnDuplicate: executor.Replay,
		}
		return (connection.Client{
			Config: loaded, Credential: credential, BridgeVersion: version,
			RecoverRuns: func(ctx context.Context, send func(context.Context, any) error) error {
				return executor.Recover(ctx, delivery.Sender(send))
			},
			HandleRun: func(ctx context.Context, message contracts.RunRequestedMessage, send func(context.Context, any) error) error {
				return runHandler.Handle(ctx, message, delivery.Sender(send))
			},
		}).Run(ctx)
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

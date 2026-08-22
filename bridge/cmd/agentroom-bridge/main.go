package main

import (
	"context"
	"flag"
	"fmt"
	"os"

	"agentroom.dev/bridge/internal/config"
	"agentroom.dev/bridge/internal/pairing"
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
		return fmt.Errorf("expected one of: version, validate-config, pair")
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
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

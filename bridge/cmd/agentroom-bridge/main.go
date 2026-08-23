package main

import (
	"context"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"agentroom.dev/bridge/internal/browserlaunch"
	"agentroom.dev/bridge/internal/config"
	"agentroom.dev/bridge/internal/connection"
	"agentroom.dev/bridge/internal/console"
	"agentroom.dev/bridge/internal/delivery"
	"agentroom.dev/bridge/internal/enrollment"
	"agentroom.dev/bridge/internal/identity"
	"agentroom.dev/bridge/internal/pairing"
	bridgeruntime "agentroom.dev/bridge/internal/runtime"
	contracts "agentroom.dev/contracts/generated/go"
)

var version = "dev"

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "agentroom-bridge:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("expected one of: version, console, validate-config, join, pair, run")
	}
	switch args[0] {
	case "version":
		fmt.Println(version)
		return nil
	case "console":
		return runConsole(args[1:])
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
	case "join":
		return join(args[1:])
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
		return runUntilSignal(loaded, credential)
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func runConsole(args []string) error {
	command := flag.NewFlagSet("console", flag.ContinueOnError)
	path := command.String("config", "", "path to bridge JSON configuration")
	dataDir := command.String("data-dir", "", "directory for Bridge state and credential")
	workspace := command.String("workspace", "", "default local Runtime workspace")
	listen := command.String("listen", "127.0.0.1:3210", "loopback Console listen address")
	noOpen := command.Bool("no-open", false, "do not open the Console in a browser")
	if err := command.Parse(args); err != nil {
		return err
	}
	resolvedPath := *path
	if resolvedPath == "" {
		resolvedPath = config.DefaultPath()
	}
	service, err := console.New(console.Options{
		ConfigPath: resolvedPath,
		DataDir:    *dataDir,
		Workspace:  *workspace,
	}, console.Dependencies{
		Enroll:         enrollment.Join,
		SaveConfig:     config.Save,
		ReplaceConfig:  config.Replace,
		SaveCredential: pairing.Save,
		RunBridge:      runBridge,
	})
	if err != nil {
		return err
	}
	defer service.Close()
	listener, err := console.ListenLoopback(*listen)
	if err != nil {
		return err
	}
	defer listener.Close()
	server := &http.Server{
		Handler:           service.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       30 * time.Second,
	}
	if err := service.StartConfiguredBridge(); err != nil {
		return err
	}
	consoleURL := "http://" + listener.Addr().String() +
		"/?token=" + url.QueryEscape(service.Token())
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	serveError := make(chan error, 1)
	go func() { serveError <- server.Serve(listener) }()

	fmt.Printf("Bridge Console: %s\n", consoleURL)
	fmt.Println("The Console accepts connections only from this machine.")
	if !*noOpen {
		if err := browserlaunch.OpenLoopback(consoleURL); err != nil {
			fmt.Fprintf(os.Stderr, "Open the printed Console URL manually: %v\n", err)
		}
	}

	select {
	case <-ctx.Done():
		shutdownContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return server.Shutdown(shutdownContext)
	case err := <-serveError:
		if err == nil || err == http.ErrServerClosed {
			return nil
		}
		return err
	}
}

func join(args []string) error {
	command := flag.NewFlagSet("join", flag.ContinueOnError)
	serverURL := command.String("server", "", "Agent Room server URL")
	path := command.String("config", "", "path for generated bridge JSON configuration")
	dataDir := command.String("data-dir", "", "directory for Bridge state and credential")
	workspace := command.String("workspace", "", "local Codex workspace")
	device := command.String("device-name", "", "Device name shown in Agent Room")
	agent := command.String("agent-name", "Local Codex", "Agent name shown in Agent Room")
	role := command.String("role", "Codex implementer", "Agent role shown in Agent Room")
	codex := command.String("codex", "", "path to the Codex executable")
	sandbox := command.String("sandbox", "workspace-write", "Codex sandbox: read-only or workspace-write")
	fingerprint := command.String("server-certificate-sha256", "", "HTTPS server certificate SHA-256 fingerprint")
	if err := command.Parse(args); err != nil {
		return err
	}
	if strings.TrimSpace(*serverURL) == "" {
		return fmt.Errorf("join requires --server")
	}
	if *sandbox != "read-only" && *sandbox != "workspace-write" {
		return fmt.Errorf("join --sandbox must be read-only or workspace-write")
	}
	resolvedPath := *path
	if resolvedPath == "" {
		resolvedPath = config.DefaultPath()
	}
	resolvedPath, err := config.EnsureAvailable(resolvedPath)
	if err != nil {
		return err
	}
	resolvedDataDir := *dataDir
	if resolvedDataDir == "" {
		resolvedDataDir = filepath.Join(filepath.Dir(resolvedPath), "data")
	}
	resolvedDataDir, err = filepath.Abs(resolvedDataDir)
	if err != nil {
		return fmt.Errorf("resolve data directory: %w", err)
	}
	if _, err := pairing.EnsureAvailable(resolvedDataDir); err != nil {
		return err
	}
	resolvedWorkspace := *workspace
	if resolvedWorkspace == "" {
		resolvedWorkspace, err = os.Getwd()
	} else {
		resolvedWorkspace, err = filepath.Abs(resolvedWorkspace)
	}
	if err != nil {
		return fmt.Errorf("resolve workspace: %w", err)
	}
	info, err := os.Stat(resolvedWorkspace)
	if err != nil || !info.IsDir() {
		return fmt.Errorf("workspace must be an existing directory")
	}
	resolvedCodex := *codex
	if resolvedCodex == "" {
		resolvedCodex, err = exec.LookPath("codex")
		if err != nil {
			return fmt.Errorf("find Codex: use --codex with its executable path")
		}
	}
	resolvedCodex, err = filepath.Abs(resolvedCodex)
	if err != nil {
		return fmt.Errorf("resolve Codex executable: %w", err)
	}
	codexInfo, err := os.Stat(resolvedCodex)
	if err != nil || codexInfo.IsDir() || codexInfo.Mode().Perm()&0o111 == 0 {
		return fmt.Errorf("Codex path must be an executable file")
	}
	resolvedDevice := strings.TrimSpace(*device)
	if resolvedDevice == "" {
		hostname, hostErr := os.Hostname()
		if hostErr != nil || strings.TrimSpace(hostname) == "" {
			return fmt.Errorf("detect device name: use --device-name")
		}
		resolvedDevice = hostname + " Codex Bridge"
	}
	loaded := config.Config{
		ServerURL: *serverURL, ServerCertificateSHA256: *fingerprint,
		DeviceName: resolvedDevice, DataDir: resolvedDataDir,
		Agents: []config.AgentConfig{{
			Name: *agent, Role: *role, Adapter: "codex",
			Command:   []string{resolvedCodex, "exec", "--json", "--sandbox", *sandbox, "-"},
			Workspace: resolvedWorkspace, EnvAllowlist: []string{"HOME", "PATH", "CODEX_HOME"},
		}},
	}
	if err := loaded.Validate(); err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	credential, err := enrollment.Join(ctx, loaded, func(challenge enrollment.Challenge) {
		fmt.Printf("Bridge join code: %s\n", challenge.UserCode)
		fmt.Printf("Approve this code in Agent Room Web before %s\n", challenge.ExpiresAt.Local().Format("2006-01-02 15:04:05 MST"))
	})
	if err != nil {
		return err
	}
	if err := config.Save(resolvedPath, loaded); err != nil {
		return err
	}
	if err := pairing.Save(resolvedDataDir, credential); err != nil {
		return err
	}
	fmt.Printf("joined Team %s as device %s; config saved to %s\n", credential.TeamID, credential.DeviceID, resolvedPath)
	return runBridge(ctx, loaded, credential)
}

func runUntilSignal(loaded config.Config, credential pairing.Credential) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return runBridge(ctx, loaded, credential)
}

func runBridge(ctx context.Context, loaded config.Config, credential pairing.Credential) error {
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
		Config: loaded, Credential: credential, BridgeVersion: version,
		RecoverRuns: func(ctx context.Context, send func(context.Context, any) error) error {
			return executor.Recover(ctx, delivery.Sender(send))
		},
		HandleRun: func(ctx context.Context, message contracts.RunRequestedMessage, send func(context.Context, any) error) error {
			return runHandler.Handle(ctx, message, delivery.Sender(send))
		},
	}).Run(ctx)
}

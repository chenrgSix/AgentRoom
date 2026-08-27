package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	bridgeartifact "agentroom.dev/bridge/internal/artifact"
	"agentroom.dev/bridge/internal/bridgecore"
	"agentroom.dev/bridge/internal/browserlaunch"
	"agentroom.dev/bridge/internal/config"
	"agentroom.dev/bridge/internal/connection"
	"agentroom.dev/bridge/internal/console"
	"agentroom.dev/bridge/internal/enrollment"
	"agentroom.dev/bridge/internal/identity"
	"agentroom.dev/bridge/internal/launchable"
	"agentroom.dev/bridge/internal/operations"
	"agentroom.dev/bridge/internal/pairing"
	"agentroom.dev/bridge/internal/provisioning"
	bridgeresult "agentroom.dev/bridge/internal/result"
	"agentroom.dev/bridge/internal/updatecheck"
	contracts "agentroom.dev/contracts/generated/go"
)

var version = "dev"

type repeatedStringFlag []string

func (values *repeatedStringFlag) String() string {
	return strings.Join(*values, ",")
}

func (values *repeatedStringFlag) Set(value string) error {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return fmt.Errorf("Artifact relation target cannot be empty")
	}
	*values = append(*values, trimmed)
	return nil
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "agentroom-bridge:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("expected one of: version, console, validate-config, join, pair-device, pair, artifact, result, run")
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
	case "pair-device":
		return pairDevice(args[1:])
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
	case "artifact":
		return runArtifact(args[1:])
	case "result":
		return runResult(args[1:])
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
		return runUntilSignal(resolved, loaded, credential)
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func runResult(args []string) error {
	if len(args) == 0 || args[0] != "propose" {
		return fmt.Errorf("result requires the propose subcommand")
	}
	command := flag.NewFlagSet("result propose", flag.ContinueOnError)
	configPath := command.String("config", "", "path to bridge JSON configuration")
	agentName := command.String("agent", "", "configured Agent name")
	runID := command.String("run-id", "", "assigned Run identity")
	proposalJSON := command.String(
		"proposal-json",
		"",
		"contract-valid Result proposal JSON (never a file path)",
	)
	if err := command.Parse(args[1:]); err != nil {
		return err
	}
	if strings.TrimSpace(*runID) == "" || strings.TrimSpace(*proposalJSON) == "" {
		return fmt.Errorf("result propose requires --run-id and --proposal-json")
	}
	resolvedConfig := *configPath
	if resolvedConfig == "" {
		resolvedConfig = config.DefaultPath()
	}
	loaded, err := config.Load(resolvedConfig)
	if err != nil {
		return err
	}
	selected, err := configuredAgent(loaded.Agents, strings.TrimSpace(*agentName))
	if err != nil {
		return err
	}
	identities, err := identity.LoadOrCreate(loaded.DataDir, loaded.Agents)
	if err != nil {
		return err
	}
	agentID := identities[selected.Name]
	if agentID == "" {
		return fmt.Errorf("configured Agent has no stable identity")
	}
	credential, err := pairing.Load(loaded.DataDir)
	if err != nil {
		return err
	}
	proposal, err := bridgeresult.ParseProposal(*proposalJSON)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	result, err := bridgeresult.NewClient(loaded, credential).Propose(
		ctx,
		bridgeresult.ProposeInput{
			AgentID:  agentID,
			RunID:    strings.TrimSpace(*runID),
			Proposal: proposal,
		},
	)
	if err != nil {
		return err
	}
	fmt.Printf(
		"proposed Result %s version %d for Task %s\n",
		result.ResultID,
		result.ResultVersion,
		result.TaskID,
	)
	return nil
}

func pairDevice(args []string) error {
	command := flag.NewFlagSet("pair-device", flag.ContinueOnError)
	path := command.String("config", "", "path to bridge JSON configuration")
	link := command.String("link", "", "Device pairing link from the Owner Web client")
	code := command.String("code", "", "manual Device pairing short code")
	if err := command.Parse(args); err != nil {
		return err
	}
	if (strings.TrimSpace(*link) == "") == (strings.TrimSpace(*code) == "") {
		return fmt.Errorf("pair-device requires exactly one of --link or --code")
	}
	resolved := *path
	if resolved == "" {
		resolved = config.DefaultPath()
	}
	loaded, err := config.Load(resolved)
	if err != nil {
		return err
	}
	if _, err := pairing.EnsureAvailable(loaded.DataDir); err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	credential, err := (pairing.SessionClient{BridgeVersion: version}).Pair(
		ctx,
		loaded,
		pairing.SessionInput{Link: *link, ShortCode: *code},
		func(status pairing.SessionStatus) {
			fmt.Printf("verify the phrase in Owner Web: %s (expires %s)\n",
				status.VerificationPhrase, status.ExpiresAt.Format(time.RFC3339))
		},
	)
	if err != nil {
		return err
	}
	if err := pairing.Save(loaded.DataDir, credential); err != nil {
		return err
	}
	fmt.Printf("paired device %s with Team %s\n", credential.DeviceID, credential.TeamID)
	return nil
}

func runArtifact(args []string) error {
	if len(args) == 0 || args[0] != "publish" {
		return fmt.Errorf("artifact requires the publish subcommand")
	}
	command := flag.NewFlagSet("artifact publish", flag.ContinueOnError)
	configPath := command.String("config", "", "path to bridge JSON configuration")
	agentName := command.String("agent", "", "configured Agent name")
	runID := command.String("run-id", "", "source Run identity")
	artifactType := command.String("type", "", "patch, document, or test_result")
	file := command.String("file", "", "Workspace-relative source file")
	title := command.String("title", "", "Artifact title")
	summary := command.String("summary", "", "Artifact summary")
	var derivesFrom repeatedStringFlag
	var reviews repeatedStringFlag
	var verifies repeatedStringFlag
	command.Var(&derivesFrom, "derives-from", "older Artifact identity consumed by this result (repeatable)")
	command.Var(&reviews, "reviews", "older Artifact identity reviewed by this result (repeatable)")
	command.Var(&verifies, "verifies", "older Artifact identity verified by this result (repeatable)")
	if err := command.Parse(args[1:]); err != nil {
		return err
	}
	if strings.TrimSpace(*runID) == "" || strings.TrimSpace(*file) == "" ||
		strings.TrimSpace(*artifactType) == "" || strings.TrimSpace(*title) == "" ||
		strings.TrimSpace(*summary) == "" {
		return fmt.Errorf(
			"artifact publish requires --run-id, --type, --file, --title, and --summary",
		)
	}
	resolvedConfig := *configPath
	if resolvedConfig == "" {
		resolvedConfig = config.DefaultPath()
	}
	loaded, err := config.Load(resolvedConfig)
	if err != nil {
		return err
	}
	selected, err := configuredAgent(loaded.Agents, strings.TrimSpace(*agentName))
	if err != nil {
		return err
	}
	identities, err := identity.LoadOrCreate(loaded.DataDir, loaded.Agents)
	if err != nil {
		return err
	}
	agentID := identities[selected.Name]
	if agentID == "" {
		return fmt.Errorf("configured Agent has no stable identity")
	}
	credential, err := pairing.Load(loaded.DataDir)
	if err != nil {
		return err
	}
	source, err := bridgeartifact.PlanSource(
		selected.Workspace,
		*file,
		strings.TrimSpace(*artifactType),
	)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	relations := make([]bridgeartifact.PublishRelation, 0,
		len(derivesFrom)+len(reviews)+len(verifies))
	for _, targetArtifactID := range derivesFrom {
		relations = append(relations, bridgeartifact.PublishRelation{
			Type: "derives_from", TargetArtifactID: targetArtifactID,
		})
	}
	for _, targetArtifactID := range reviews {
		relations = append(relations, bridgeartifact.PublishRelation{
			Type: "reviews", TargetArtifactID: targetArtifactID,
		})
	}
	for _, targetArtifactID := range verifies {
		relations = append(relations, bridgeartifact.PublishRelation{
			Type: "verifies", TargetArtifactID: targetArtifactID,
		})
	}
	result, err := bridgeartifact.NewClient(loaded, credential).Publish(
		ctx,
		bridgeartifact.PublishInput{
			RunID: strings.TrimSpace(*runID), AgentID: agentID,
			ArtifactType: strings.TrimSpace(*artifactType),
			Title:        strings.TrimSpace(*title), Summary: strings.TrimSpace(*summary),
			Source: source, Relations: relations,
		},
	)
	if err != nil {
		return err
	}
	fmt.Printf(
		"published Artifact %s from operation %s (content %s, sha256 %s)\n",
		result.ArtifactID,
		result.PublicationID,
		result.ContentID,
		result.SHA256,
	)
	return nil
}

func configuredAgent(
	agents []config.AgentConfig,
	requestedName string,
) (config.AgentConfig, error) {
	if requestedName == "" {
		if len(agents) != 1 {
			return config.AgentConfig{}, fmt.Errorf(
				"configured Agent selection requires --agent when multiple Agents are configured",
			)
		}
		return agents[0], nil
	}
	for _, agent := range agents {
		if agent.Name == requestedName {
			return agent, nil
		}
	}
	return config.AgentConfig{}, fmt.Errorf(
		"configured Agent %q was not found",
		requestedName,
	)
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
		Version:    version,
	}, console.Dependencies{
		Enroll: enrollment.Join,
		PairDevice: func(ctx context.Context, loaded config.Config, input pairing.SessionInput, show func(pairing.SessionStatus)) (pairing.Credential, error) {
			return (pairing.SessionClient{BridgeVersion: version}).Pair(ctx, loaded, input, show)
		},
		SaveConfig:     config.Save,
		ReplaceConfig:  config.Replace,
		SaveCredential: pairing.Save,
		UpdateChecker:  updatecheck.New(),
		ProbeRuntime:   console.ProbeRuntime,
		RunBridge: func(ctx context.Context, loaded config.Config, credential pairing.Credential, observer operations.Observer) error {
			return bridgecore.RunObserved(ctx, loaded, credential, version, observer)
		},
		RunBridgeWithProvisioning: func(ctx context.Context, loaded config.Config, credential pairing.Credential, observer operations.Observer, handler connection.ProvisionHandler) error {
			return bridgecore.RunObservedWithProvisioning(ctx, loaded, credential, version, observer, handler)
		},
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
	serverToken := command.String("server-token", "", "central Server Token")
	path := command.String("config", "", "path for generated bridge JSON configuration")
	dataDir := command.String("data-dir", "", "directory for Bridge state and credential")
	workspace := command.String("workspace", "", "local Codex workspace")
	device := command.String("device-name", "", "Device name shown in Agent Room")
	agent := command.String("agent-name", "Local Codex", "Agent name shown in Agent Room")
	role := command.String("role", "Codex implementer", "Agent role shown in Agent Room")
	codex := command.String("codex", "", "path to the Codex executable")
	sandbox := command.String("sandbox", "workspace-write", "Codex sandbox: read-only or workspace-write")
	sessionConflictPolicy := command.String(
		"codex-session-conflict-policy",
		string(config.CodexSessionConflictPreserveAndRetry),
		"Codex active-writer policy: preserve_and_retry or start_new",
	)
	fingerprint := command.String("server-certificate-sha256", "", "HTTPS server certificate SHA-256 fingerprint")
	trustMode := command.String("server-trust-mode", "", "HTTPS trust: system_ca or pinned_sha256")
	if err := command.Parse(args); err != nil {
		return err
	}
	if strings.TrimSpace(*serverURL) == "" {
		return fmt.Errorf("join requires --server")
	}
	if *sandbox != "read-only" && *sandbox != "workspace-write" {
		return fmt.Errorf("join --sandbox must be read-only or workspace-write")
	}
	resolvedSessionConflictPolicy := config.CodexSessionConflictPolicy(*sessionConflictPolicy)
	if resolvedSessionConflictPolicy != config.CodexSessionConflictPreserveAndRetry &&
		resolvedSessionConflictPolicy != config.CodexSessionConflictStartNew {
		return fmt.Errorf("join --codex-session-conflict-policy must be preserve_and_retry or start_new")
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
	if !launchable.File(resolvedCodex, runtime.GOOS) {
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
	resolvedTrustMode := config.TrustSystemCA
	if strings.TrimSpace(*fingerprint) != "" {
		resolvedTrustMode = config.TrustPinnedSHA256
	}
	if strings.TrimSpace(*trustMode) != "" {
		resolvedTrustMode = config.TrustMode(strings.TrimSpace(*trustMode))
	}
	loaded := config.Config{
		ServerURL: *serverURL, ServerToken: strings.TrimSpace(*serverToken), ServerTrustMode: resolvedTrustMode,
		ServerCertificateSHA256: *fingerprint,
		DeviceName:              resolvedDevice, DataDir: resolvedDataDir,
		Agents: []config.AgentConfig{{
			Name: *agent, Role: *role, Adapter: "codex", RuntimeKind: "codex",
			PresetVersion: config.CurrentPresetVersion,
			Command:       config.CodexPresetCommand(resolvedCodex), Sandbox: *sandbox,
			CodexSessionConflictPolicy: resolvedSessionConflictPolicy,
			Workspace:                  resolvedWorkspace,
			EnvAllowlist:               []string{"HOME", "PATH", "CODEX_HOME"},
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
	return runManaged(ctx, resolvedPath, loaded, credential)
}

func runUntilSignal(configPath string, loaded config.Config, credential pairing.Credential) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return runManaged(ctx, configPath, loaded, credential)
}

func runManaged(
	ctx context.Context,
	configPath string,
	loaded config.Config,
	credential pairing.Credential,
) error {
	authorizer := &provisioning.Authorizer{}
	for {
		handler := connection.ProvisionHandler(func(
			_ context.Context,
			requested contracts.AgentProvisionRequestedMessage,
		) contracts.AgentProvisionResultMessage {
			decision := provisioning.Apply(
				loaded,
				configPath,
				config.Replace,
				authorizer,
				requested.Payload,
				time.Now(),
			)
			if !decision.Accepted {
				return connection.ProvisionResult(requested, contracts.Rejected, decision.Reason)
			}
			return connection.ProvisionResult(requested, contracts.Accepted, "")
		})
		err := bridgecore.RunObservedWithProvisioning(
			ctx,
			loaded,
			credential,
			version,
			operations.Observer{},
			handler,
		)
		if !errors.Is(err, connection.ErrConfigurationChanged) || ctx.Err() != nil {
			return err
		}
		reloaded, loadErr := config.Load(configPath)
		if loadErr != nil {
			return loadErr
		}
		loaded = reloaded
	}
}

package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"convenewire.dev/bridge/internal/admission"
	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/identity"
	"convenewire.dev/bridge/internal/pairing"
	execution "convenewire.dev/contracts/generated/go/execution"
)

func repositoryIntegrationCommand(args []string, output io.Writer, _ func() time.Time) error {
	if len(args) == 0 || args[0] != "execute" {
		return fmt.Errorf("repository integration requires execute; it never merges, pushes, rebases or resets")
	}
	flags := flag.NewFlagSet("repository integration execute", flag.ContinueOnError)
	configPath := flags.String("config", "", "local Bridge configuration")
	operationID := flags.String("operation-id", "", "exact Central-approved op_integration_ identity")
	confirm := flags.Bool("confirm", false, "confirm execution of this exact integration operation")
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	if flags.NArg() != 0 || !*confirm || !strings.HasPrefix(*operationID, "op_integration_") {
		return fmt.Errorf("integration execute requires --operation-id op_integration_... --confirm and no positional arguments")
	}
	resolved := *configPath
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
	identities, err := identity.LoadOrCreate(loaded.DataDir, loaded.Agents)
	if err != nil {
		return err
	}
	agents := make(map[string]config.AgentConfig, len(loaded.Agents))
	for _, agent := range loaded.Agents {
		agentID := identities[agent.Name]
		if agentID == "" {
			return fmt.Errorf("configured Agent has no stable identity")
		}
		agents[agentID] = agent
	}
	git, err := exec.LookPath("git")
	if err != nil {
		return fmt.Errorf("repository integration requires local Git")
	}
	git, err = filepath.Abs(git)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	resources, err := admission.OpenGovernedAdmissionResources(ctx, loaded, credential, git, agents)
	if err != nil {
		return err
	}
	defer resources.Close()
	coordinator := resources.IntegrationCoordinator()
	if coordinator == nil {
		return admission.ErrAdmissionInvalid
	}
	retained, err := coordinator.Execute(ctx, *operationID)
	if err != nil {
		return err
	}
	if err := json.NewEncoder(output).Encode(retained); err != nil {
		return err
	}
	if retained.Receipt.State != execution.PurpleSucceeded {
		return fmt.Errorf("integration retained terminal state %s", retained.Receipt.State)
	}
	return nil
}

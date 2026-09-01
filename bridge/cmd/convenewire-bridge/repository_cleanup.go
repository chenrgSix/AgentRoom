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
	"convenewire.dev/bridge/internal/pairing"
	"convenewire.dev/bridge/internal/repository"
	execution "convenewire.dev/contracts/generated/go/execution"
)

func repositoryCleanupCommand(args []string, output io.Writer, clock func() time.Time) error {
	if len(args) == 0 || (args[0] != "grant" && args[0] != "preview" && args[0] != "execute") {
		return fmt.Errorf("repository cleanup requires grant, preview, or execute")
	}
	if args[0] == "grant" {
		return repositoryCleanupGrantCommand(args[1:], output, clock)
	}
	flags := flag.NewFlagSet("repository cleanup "+args[0], flag.ContinueOnError)
	configPath := flags.String("config", "", "local Bridge configuration")
	grantID := flags.String("grant-id", "", "exact cleanupgrant_ owner consent")
	operationID := flags.String("operation-id", "", "exact op_cleanup_ identity")
	checkpointFile := flags.String("checkpoint-file", "", "absolute canonical RepositoryCheckpoint JSON")
	expectedPreview := flags.String("expected-preview-digest", "", "reviewed preview digest")
	confirm := flags.Bool("confirm", false, "confirm the exact reviewed cleanup preview")
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	if flags.NArg() != 0 || *grantID == "" || *operationID == "" || *checkpointFile == "" ||
		(args[0] == "execute" && (!*confirm || *expectedPreview == "")) ||
		(args[0] == "preview" && (*confirm || *expectedPreview != "")) {
		return fmt.Errorf("cleanup preview/execute requires exact grant, operation and checkpoint; execute also requires reviewed digest and --confirm")
	}
	if !strings.HasPrefix(*grantID, "cleanupgrant_") || !strings.HasPrefix(*operationID, "op_cleanup_") ||
		(args[0] == "execute" && len(*expectedPreview) != 64) {
		return fmt.Errorf("cleanup identifiers or reviewed digest are invalid")
	}
	checkpoint, err := readCleanupCheckpoint(*checkpointFile)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	resources, closeResources, err := openCleanupResources(ctx, *configPath, true)
	if err != nil {
		return err
	}
	defer closeResources()
	coordinator, err := resources.CleanupCoordinator(*grantID)
	if err != nil {
		return err
	}
	var result any
	if args[0] == "preview" {
		result, err = coordinator.Preview(ctx, *operationID, checkpoint)
	} else {
		result, err = coordinator.Execute(ctx, repository.CleanupRequest{
			OperationID: *operationID, Checkpoint: checkpoint, ExpectedPreviewDigest: *expectedPreview})
	}
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(result)
}

func repositoryCleanupGrantCommand(args []string, output io.Writer, clock func() time.Time) error {
	if len(args) == 0 || (args[0] != "issue" && args[0] != "list" && args[0] != "revoke") {
		return fmt.Errorf("repository cleanup grant requires issue, list, or revoke")
	}
	flags := flag.NewFlagSet("repository cleanup grant "+args[0], flag.ContinueOnError)
	configPath := flags.String("config", "", "local Bridge configuration")
	grantID := flags.String("grant-id", "", "exact cleanupgrant_ identity")
	operationID := flags.String("operation-id", "", "exact op_cleanup_ identity")
	checkpointFile := flags.String("checkpoint-file", "", "absolute canonical RepositoryCheckpoint JSON")
	expiresAt := flags.String("expires-at", "", "exact cleanup consent expiry")
	expectedDigest := flags.String("expected-digest", "", "reviewed immutable grant digest")
	expectedRevision := flags.Int64("expected-revision", 0, "reviewed issuance revision (1)")
	confirm := flags.Bool("confirm", false, "confirm exact local cleanup consent or revocation")
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	if flags.NArg() != 0 || (args[0] != "list" && !*confirm) {
		return fmt.Errorf("cleanup grant mutations require --confirm and no positional arguments")
	}
	switch args[0] {
	case "issue":
		if *grantID == "" || *operationID == "" || *checkpointFile == "" || *expiresAt == "" ||
			*expectedRevision != 0 || *expectedDigest != "" ||
			!strings.HasPrefix(*grantID, "cleanupgrant_") || !strings.HasPrefix(*operationID, "op_cleanup_") {
			return fmt.Errorf("cleanup grant issue requires only an exact grant, operation, checkpoint, expiry and --confirm")
		}
	case "list":
		if *confirm || *grantID != "" || *operationID != "" || *checkpointFile != "" || *expiresAt != "" ||
			*expectedRevision != 0 || *expectedDigest != "" {
			return fmt.Errorf("cleanup grant list accepts only --config")
		}
	case "revoke":
		if *grantID == "" || *expectedRevision != 1 || *expectedDigest == "" ||
			*operationID != "" || *checkpointFile != "" || *expiresAt != "" ||
			!strings.HasPrefix(*grantID, "cleanupgrant_") {
			return fmt.Errorf("cleanup grant revoke requires only an exact grant, revision 1, digest and --confirm")
		}
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	resources, closeResources, err := openCleanupResources(ctx, *configPath, args[0] == "issue")
	if err != nil {
		return err
	}
	defer closeResources()
	var result any
	switch args[0] {
	case "issue":
		checkpoint, readErr := readCleanupCheckpoint(*checkpointFile)
		if readErr != nil {
			return readErr
		}
		result, err = resources.IssueCleanupGrant(ctx, *grantID, *operationID,
			checkpoint, *expiresAt, clock())
	case "list":
		result, err = resources.ListCleanupGrants()
	case "revoke":
		result, err = resources.RevokeCleanupGrant(*grantID, *expectedRevision, *expectedDigest, clock())
	}
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(result)
}

func openCleanupResources(ctx context.Context, configPath string, requireGit bool) (*admission.GovernedAdmissionResources, func(), error) {
	resolved := configPath
	if resolved == "" {
		resolved = config.DefaultPath()
	}
	loaded, err := config.Load(resolved)
	if err != nil {
		return nil, nil, err
	}
	credential, err := pairing.Load(loaded.DataDir)
	if err != nil {
		return nil, nil, err
	}
	git := ""
	if requireGit {
		git, err = exec.LookPath("git")
		if err != nil {
			return nil, nil, fmt.Errorf("repository cleanup requires local Git")
		}
		git, err = filepath.Abs(git)
		if err != nil {
			return nil, nil, err
		}
	}
	// Cleanup is recovery authority over an already-journaled Run. It must not
	// provision identities or require the Agent to remain in current config.
	resources, err := admission.OpenGovernedAdmissionResources(ctx, loaded, credential, git, nil)
	if err != nil {
		return nil, nil, err
	}
	return resources, func() { _ = resources.Close() }, nil
}

func readCleanupCheckpoint(path string) (execution.RepositoryCheckpoint, error) {
	var checkpoint execution.RepositoryCheckpoint
	if !filepath.IsAbs(path) {
		return checkpoint, fmt.Errorf("checkpoint file must be absolute")
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > 512<<10 {
		return checkpoint, fmt.Errorf("checkpoint file must be a bounded regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return checkpoint, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return checkpoint, fmt.Errorf("checkpoint file identity changed")
	}
	decoder := json.NewDecoder(io.LimitReader(file, (512<<10)+1))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&checkpoint); err != nil {
		return checkpoint, err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return checkpoint, fmt.Errorf("checkpoint file has trailing content")
	}
	return checkpoint, nil
}

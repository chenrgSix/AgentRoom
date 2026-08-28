package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"convenewire.dev/convenewirectl/internal/controller"
)

var version = "development"

func main() {
	if err := run(context.Background(), os.Args[1:]); err != nil {
		var action *controller.ActionError
		if errors.As(err, &action) {
			fmt.Fprintf(os.Stderr, "ERROR [%s]: %s\n", action.Code, action.Message)
			if action.Cause != nil {
				fmt.Fprintf(os.Stderr, "Detail: %v\n", action.Cause)
			}
			if action.Hint != "" {
				fmt.Fprintf(os.Stderr, "Next: %s\n", action.Hint)
			}
		} else {
			fmt.Fprintf(os.Stderr, "ERROR: %v\n", err)
		}
		os.Exit(1)
	}
}

func run(ctx context.Context, arguments []string) error {
	if len(arguments) == 0 {
		return fmt.Errorf("usage: convenewirectl <install|status|doctor|backup|restore|upgrade|trust-rotation|migrate-public-ca|migrate-private-hostname|uninstall|version>")
	}
	if arguments[0] == "version" {
		fmt.Println(version)
		return nil
	}
	control := controller.New(controller.DefaultDependencies(os.Stdout))
	switch arguments[0] {
	case "install":
		flags := flag.NewFlagSet("install", flag.ContinueOnError)
		flags.SetOutput(os.Stderr)
		releaseDir := flags.String("release-dir", defaultReleaseDir(), "extracted checksum-pinned central release")
		checksums := flags.String("checksums", "", "SHA256SUMS inside the release root")
		checksumPin := flags.String("checksums-sha256", "", "published SHA-256 of SHA256SUMS")
		dataRoot := flags.String("data-root", defaultDataRoot(), "persistent ConveneWire data root")
		mode := flags.String("mode", "local", "local or direct_https")
		tlsProfile := flags.String("tls-profile", "", "direct_https TLS profile: public_ca (default), private_scoped_ca, or manual_ca")
		domain := flags.String("domain", "localhost", "exact HTTPS host name or IP")
		origin := flags.String("origin", "https://localhost:9443", "exact public HTTPS origin")
		httpPort := flags.Int("http-port", 9080, "published HTTP redirect/ACME port")
		httpsPort := flags.Int("https-port", 9443, "published application HTTPS port")
		legacyToken := flags.Bool("legacy-server-token", false, "generate a private legacy Bridge Server Token")
		projectName := flags.String("project-name", "agentroom", "stable Docker Compose project identity")
		if err := flags.Parse(arguments[1:]); err != nil {
			return err
		}
		if flags.NArg() != 0 {
			return fmt.Errorf("install accepts flags only")
		}
		_, err := control.Install(ctx, controller.InstallOptions{
			ReleaseDir: *releaseDir, ChecksumsPath: *checksums,
			ChecksumsSHA256: *checksumPin,
			DataRoot:        *dataRoot, Mode: *mode, TLSProfile: *tlsProfile, Domain: *domain,
			PublicOrigin: *origin, HTTPPort: *httpPort, HTTPSPort: *httpsPort,
			LegacyServerToken: *legacyToken,
			ProjectName:       *projectName,
		})
		return err
	case "status", "doctor", "backup", "uninstall":
		flags := flag.NewFlagSet(arguments[0], flag.ContinueOnError)
		flags.SetOutput(os.Stderr)
		dataRoot := flags.String("data-root", defaultDataRoot(), "persistent ConveneWire data root")
		if err := flags.Parse(arguments[1:]); err != nil {
			return err
		}
		if flags.NArg() != 0 {
			return fmt.Errorf("%s accepts flags only", arguments[0])
		}
		switch arguments[0] {
		case "status":
			return control.Status(ctx, *dataRoot)
		case "doctor":
			return control.Doctor(ctx, *dataRoot)
		case "backup":
			return control.Backup(ctx, *dataRoot)
		default:
			return control.Uninstall(ctx, *dataRoot)
		}
	case "restore":
		flags := flag.NewFlagSet("restore", flag.ContinueOnError)
		flags.SetOutput(os.Stderr)
		dataRoot := flags.String("data-root", defaultDataRoot(), "persistent ConveneWire data root")
		targetName := flags.String("target-name", "", "optional unique staged .sqlite filename")
		if err := flags.Parse(arguments[1:]); err != nil {
			return err
		}
		if flags.NArg() != 1 {
			return fmt.Errorf("usage: convenewirectl restore [flags] /absolute/backup.sqlite")
		}
		return control.Restore(ctx, *dataRoot, flags.Arg(0), *targetName)
	case "upgrade":
		flags := flag.NewFlagSet("upgrade", flag.ContinueOnError)
		flags.SetOutput(os.Stderr)
		dataRoot := flags.String("data-root", defaultDataRoot(), "persistent ConveneWire data root")
		releaseDir := flags.String("release-dir", "", "target extracted checksum-pinned central release")
		checksums := flags.String("checksums", "", "SHA256SUMS inside the target release root")
		checksumPin := flags.String("checksums-sha256", "", "published SHA-256 of target SHA256SUMS")
		if err := flags.Parse(arguments[1:]); err != nil {
			return err
		}
		if flags.NArg() != 0 || strings.TrimSpace(*releaseDir) == "" {
			return fmt.Errorf("upgrade requires --release-dir and accepts no positional arguments")
		}
		return control.Upgrade(ctx, controller.UpgradeOptions{
			DataRoot: *dataRoot, ReleaseDir: *releaseDir, ChecksumsPath: *checksums,
			ChecksumsSHA256: *checksumPin,
		})
	case "trust-rotation":
		if len(arguments) < 2 || (arguments[1] != "prepare" && arguments[1] != "activate") {
			return fmt.Errorf("usage: convenewirectl trust-rotation <prepare|activate> [flags]")
		}
		flags := flag.NewFlagSet("trust-rotation "+arguments[1], flag.ContinueOnError)
		flags.SetOutput(os.Stderr)
		dataRoot := flags.String("data-root", defaultDataRoot(), "persistent ConveneWire data root")
		overlap := flags.String("overlap", "24h", "prepare-only current/next CA overlap from 1h through 720h")
		if err := flags.Parse(arguments[2:]); err != nil {
			return err
		}
		if flags.NArg() != 0 {
			return fmt.Errorf("trust-rotation %s accepts flags only", arguments[1])
		}
		if arguments[1] == "activate" {
			if *overlap != "24h" {
				return fmt.Errorf("--overlap applies only to trust-rotation prepare")
			}
			return control.ActivatePrivateCARotation(ctx, *dataRoot)
		}
		duration, err := time.ParseDuration(*overlap)
		if err != nil {
			return fmt.Errorf("invalid --overlap: %w", err)
		}
		return control.PreparePrivateCARotation(ctx, controller.PrivateCARotationOptions{
			DataRoot: *dataRoot,
			Overlap:  duration,
		})
	case "migrate-public-ca":
		flags := flag.NewFlagSet("migrate-public-ca", flag.ContinueOnError)
		flags.SetOutput(os.Stderr)
		dataRoot := flags.String("data-root", defaultDataRoot(), "persistent ConveneWire data root")
		if err := flags.Parse(arguments[1:]); err != nil {
			return err
		}
		if flags.NArg() != 0 {
			return fmt.Errorf("migrate-public-ca accepts flags only")
		}
		return control.MigrateLegacyPublicCA(ctx, *dataRoot)
	case "migrate-private-hostname":
		flags := flag.NewFlagSet("migrate-private-hostname", flag.ContinueOnError)
		flags.SetOutput(os.Stderr)
		dataRoot := flags.String("data-root", defaultDataRoot(), "persistent ConveneWire data root")
		hostname := flags.String("hostname", "", "stable private DNS or mDNS hostname")
		if err := flags.Parse(arguments[1:]); err != nil {
			return err
		}
		if flags.NArg() != 0 || strings.TrimSpace(*hostname) == "" {
			return fmt.Errorf("migrate-private-hostname requires --hostname and accepts flags only")
		}
		return control.MigratePrivateHostname(ctx, controller.PrivateHostnameMigrationOptions{
			DataRoot: *dataRoot,
			Hostname: *hostname,
		})
	default:
		return fmt.Errorf("unknown command %q", arguments[0])
	}
}

func defaultReleaseDir() string {
	executable, err := os.Executable()
	if err == nil {
		root := filepath.Dir(executable)
		if filepath.Base(root) == "bin" {
			root = filepath.Dir(root)
		}
		if _, err := os.Stat(filepath.Join(root, "convenewire-central-release.json")); err == nil {
			return root
		}
	}
	current, err := os.Getwd()
	if err != nil {
		return "."
	}
	return current
}

func defaultDataRoot() string {
	if runtime.GOOS == "darwin" {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, "Library", "Application Support", "AgentRoom", "Central")
		}
	}
	return "/var/lib/agentroom"
}

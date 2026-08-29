package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"convenewire.dev/convenewirectl/internal/releaseimage"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "ERROR:", err)
		os.Exit(1)
	}
}

func run(arguments []string) error {
	if len(arguments) == 0 {
		return fmt.Errorf("usage: convenewire-release-image <finalize|verify> [flags]")
	}
	switch arguments[0] {
	case "finalize":
		flags := flag.NewFlagSet("finalize", flag.ContinueOnError)
		serverInput := flags.String("server-input", "", "raw BuildKit server OCI archive")
		caddyInput := flags.String("caddy-input", "", "raw BuildKit caddy OCI archive")
		output := flags.String("output", "", "final offline OCI image archive")
		metadataOutput := flags.String("metadata-output", "", "final bundle metadata JSON")
		embeddedArchive := flags.String("embedded-archive", "", "archive path after Central packaging")
		releaseVersion := flags.String("release-version", "", "v-prefixed release version")
		sourceCommit := flags.String("source-commit", "", "exact source commit")
		platform := flags.String("platform", "", "linux/amd64 or linux/arm64")
		builderID := flags.String("builder-id", "", "provenance builder identity")
		invocationURI := flags.String("invocation-uri", "", "optional hosted build invocation URI")
		if err := flags.Parse(arguments[1:]); err != nil {
			return err
		}
		if flags.NArg() != 0 {
			return fmt.Errorf("finalize accepts flags only")
		}
		_, err := releaseimage.Finalize(releaseimage.FinalizeOptions{
			Images: []releaseimage.RawImage{
				{Role: releaseimage.ServerRole, Repository: releaseimage.ServerRepository, Archive: *serverInput},
				{Role: releaseimage.CaddyRole, Repository: releaseimage.CaddyRepository, Archive: *caddyInput},
			},
			OutputArchive: *output, OutputMetadata: *metadataOutput,
			EmbeddedArchive: *embeddedArchive, ReleaseVersion: *releaseVersion,
			SourceCommit: *sourceCommit, Platform: *platform, BuilderID: *builderID,
			BuildInvocationURI: *invocationURI,
		})
		return err
	case "verify":
		flags := flag.NewFlagSet("verify", flag.ContinueOnError)
		bundleRoot := flags.String("bundle-root", "", "extracted Central release root")
		metadata := flags.String("metadata", "", "metadata path relative to the release root")
		releaseVersion := flags.String("release-version", "", "expected release version")
		sourceCommit := flags.String("source-commit", "", "expected source commit")
		targetArch := flags.String("target-arch", "", "expected host architecture")
		if err := flags.Parse(arguments[1:]); err != nil {
			return err
		}
		if flags.NArg() != 0 {
			return fmt.Errorf("verify accepts flags only")
		}
		root, err := filepath.Abs(*bundleRoot)
		if err != nil {
			return err
		}
		_, err = releaseimage.VerifyBundle(root, *metadata, *releaseVersion, *sourceCommit, *targetArch)
		return err
	default:
		return fmt.Errorf("unknown command %q", arguments[0])
	}
}

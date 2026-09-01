package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"convenewire.dev/bridge/internal/verification"
)

func repositoryVerifierCommand(args []string, output io.Writer, clock func() time.Time) error {
	if len(args) == 0 || (args[0] != "register" && args[0] != "list" && args[0] != "revoke") {
		return fmt.Errorf("repository verifier requires register, list, or revoke; a verifier profile is not Task authority")
	}
	flags := flag.NewFlagSet("repository verifier "+args[0], flag.ContinueOnError)
	configPath := flags.String("config", "", "local Bridge configuration")
	var file, profileID, expectedDigest string
	var expectedRevision int64
	var confirm bool
	if args[0] != "list" {
		flags.BoolVar(&confirm, "confirm", false, "confirm exact verifier profile registration or revocation")
	}
	if args[0] == "register" {
		flags.StringVar(&file, "file", "", "absolute owner-reviewed local verification ProfileSpec JSON file")
	}
	if args[0] == "revoke" {
		flags.StringVar(&profileID, "profile-id", "", "exact profile_ identity")
		flags.Int64Var(&expectedRevision, "expected-revision", 0, "reviewed registration revision (1)")
		flags.StringVar(&expectedDigest, "expected-digest", "", "reviewed immutable registration digest")
	}
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	if flags.NArg() != 0 || (args[0] != "list" && !confirm) {
		return fmt.Errorf("verifier profile mutations require --confirm and no positional arguments")
	}
	var spec verification.ProfileSpec
	if args[0] == "register" {
		var err error
		spec, err = readVerificationProfileSpec(file)
		if err != nil {
			return err
		}
	}
	if args[0] == "revoke" && (profileID == "" || expectedRevision != 1 || expectedDigest == "") {
		return fmt.Errorf("verifier revoke requires --profile-id, --expected-revision 1, --expected-digest and --confirm")
	}
	session, err := openLocalOwner(*configPath, args[0] == "register", clock)
	if err != nil {
		return err
	}
	defer session.Close()
	store, err := verification.OpenProfileStore(session.DataDir, session.VerificationOwner())
	if err != nil {
		return err
	}
	defer store.Close()
	var result any
	switch args[0] {
	case "register":
		result, err = store.Register(spec, clock())
	case "list":
		result, err = store.List()
	case "revoke":
		result, err = store.Revoke(profileID, expectedRevision, expectedDigest, clock())
	}
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(result)
}

func readVerificationProfileSpec(path string) (verification.ProfileSpec, error) {
	var empty verification.ProfileSpec
	if !filepath.IsAbs(path) {
		return empty, fmt.Errorf("verifier register requires an absolute --file and --confirm")
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() < 1 || info.Size() > 64<<10 {
		return empty, fmt.Errorf("verifier profile file must be a bounded regular local file")
	}
	file, err := os.Open(path)
	if err != nil {
		return empty, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return empty, fmt.Errorf("verifier profile file identity changed")
	}
	raw, err := io.ReadAll(io.LimitReader(file, (64<<10)+1))
	if err != nil {
		return empty, err
	}
	return verification.DecodeProfileSpec(raw)
}

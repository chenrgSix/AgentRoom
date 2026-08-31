package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"convenewire.dev/bridge/internal/identity"
	"convenewire.dev/bridge/internal/repository"
)

func repositoryGrantCommand(args []string, output io.Writer, clock func() time.Time) error {
	if len(args) == 0 || (args[0] != "issue" && args[0] != "list" && args[0] != "revoke") {
		return fmt.Errorf("repository grant requires issue, list, or revoke; local consent does not enable a Runtime")
	}
	flags := flag.NewFlagSet("repository grant "+args[0], flag.ContinueOnError)
	configPath := flags.String("config", "", "local Bridge configuration")
	var confirm bool
	var file, grant, expectedDigest string
	var expectedRevision int64
	if args[0] != "list" {
		flags.BoolVar(&confirm, "confirm", false, "confirm the exact owner-reviewed local consent or revocation")
	}
	if args[0] == "issue" {
		flags.StringVar(&file, "file", "", "absolute local TaskGrantSpec JSON file; no shell commands or credentials")
	}
	if args[0] == "revoke" {
		flags.StringVar(&grant, "grant-id", "", "exact grant_ identity")
		flags.Int64Var(&expectedRevision, "expected-revision", 0, "reviewed issuance revision (1)")
		flags.StringVar(&expectedDigest, "expected-digest", "", "reviewed immutable issuance digest")
	}
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	if flags.NArg() != 0 || (args[0] != "list" && !confirm) {
		return fmt.Errorf("grant mutations require --confirm and no positional arguments")
	}
	var spec repository.TaskGrantSpec
	if args[0] == "issue" {
		var err error
		spec, err = readTaskGrantSpec(file)
		if err != nil {
			return err
		}
	}
	if args[0] == "revoke" && (grant == "" || expectedRevision != 1 || expectedDigest == "") {
		return fmt.Errorf("grant revoke requires --grant-id, --expected-revision 1 and --expected-digest")
	}
	loaded, store, closeStore, err := openRepositoryStore(*configPath, args[0] == "issue", clock)
	if err != nil {
		return err
	}
	defer closeStore()
	var result any
	switch args[0] {
	case "issue":
		if _, err := identity.LookupConfigured(loaded.DataDir, loaded.Agents, spec.AgentID); err != nil {
			return err
		}
		result, err = store.IssueTaskGrant(context.Background(), spec, clock())
	case "list":
		result, err = store.ListTaskGrants()
	case "revoke":
		result, err = store.RevokeTaskGrant(grant, expectedRevision, expectedDigest, clock())
	}
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(result)
}

func readTaskGrantSpec(path string) (repository.TaskGrantSpec, error) {
	var empty repository.TaskGrantSpec
	if !filepath.IsAbs(path) {
		return empty, fmt.Errorf("grant issue requires an absolute --file and --confirm")
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 64<<10 {
		return empty, fmt.Errorf("grant file must be a bounded regular local file")
	}
	file, err := os.Open(path)
	if err != nil {
		return empty, err
	}
	defer file.Close()
	actual, err := file.Stat()
	if err != nil || !os.SameFile(info, actual) {
		return empty, fmt.Errorf("grant file identity changed")
	}
	raw, err := io.ReadAll(io.LimitReader(file, (64<<10)+1))
	if err != nil {
		return empty, err
	}
	return repository.DecodeTaskGrantSpec(raw)
}

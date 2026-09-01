package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"convenewire.dev/bridge/internal/repository"
)

type repositoryRoots []string

func (r *repositoryRoots) String() string { return fmt.Sprint([]string(*r)) }
func (r *repositoryRoots) Set(value string) error {
	if !filepath.IsAbs(value) {
		return fmt.Errorf("allowed-root must be an absolute owner-selected directory")
	}
	*r = append(*r, value)
	return nil
}

func runRepository(args []string) error { return repositoryCommand(args, os.Stdout, time.Now) }

func repositoryCommand(args []string, output io.Writer, clock func() time.Time) error {
	if len(args) > 0 && args[0] == "grant" {
		return repositoryGrantCommand(args[1:], output, clock)
	}
	if len(args) > 0 && args[0] == "profile" {
		return repositoryProfileCommand(args[1:], output, clock)
	}
	if len(args) > 0 && args[0] == "verifier" {
		return repositoryVerifierCommand(args[1:], output, clock)
	}
	if len(args) > 0 && args[0] == "integration" {
		return repositoryIntegrationCommand(args[1:], output, clock)
	}
	if len(args) == 0 || (args[0] != "bind" && args[0] != "list" && args[0] != "revoke") {
		return fmt.Errorf("repository requires bind, list, or revoke; registration is not a Runtime grant")
	}
	command := flag.NewFlagSet("repository "+args[0], flag.ContinueOnError)
	configPath := command.String("config", "", "local Bridge configuration")
	var binding, repo, alias, workspace string
	var roots repositoryRoots
	var confirm bool
	var expected int
	if args[0] != "list" {
		command.StringVar(&binding, "binding-id", "", "exact local repobind_ identity; reuse only for identical retries")
		command.BoolVar(&confirm, "confirm", false, "explicitly confirm this local registration or revocation")
	}
	if args[0] == "bind" {
		command.StringVar(&repo, "repository-id", "", "logical repo_ identity; not proof of Central enrollment")
		command.StringVar(&alias, "alias", "", "safe display alias")
		command.StringVar(&workspace, "workspace", "", "absolute explicitly selected Git root")
		command.Var(&roots, "allowed-root", "absolute owner-approved root covering checkout and Git metadata (repeatable)")
	}
	if args[0] == "revoke" {
		command.IntVar(&expected, "expected-revision", 0, "reviewed binding revision (1)")
	}
	if err := command.Parse(args[1:]); err != nil {
		return err
	}
	if command.NArg() != 0 {
		return fmt.Errorf("repository does not accept positional paths or commands")
	}
	if args[0] != "list" && (!confirm || binding == "") {
		return fmt.Errorf("repository mutation requires --binding-id and --confirm")
	}
	if args[0] == "bind" && (repo == "" || alias == "" || !filepath.IsAbs(workspace) || len(roots) == 0) {
		return fmt.Errorf("repository bind requires --repository-id, --alias, absolute --workspace and --allowed-root")
	}
	if args[0] == "revoke" && expected != 1 {
		return fmt.Errorf("repository revoke requires --expected-revision 1")
	}
	_, store, closeStore, err := openRepositoryStore(*configPath, args[0] == "bind", clock)
	if err != nil {
		return err
	}
	defer closeStore()
	var result any
	switch args[0] {
	case "bind":
		result, err = store.Bind(context.Background(), repository.BindRepository{BindingID: binding, RepositoryID: repo,
			Alias: alias, SelectedRoot: workspace, AllowedRoots: roots}, clock())
	case "list":
		result, err = store.List()
	case "revoke":
		result, err = store.Revoke(binding, expected, clock())
	}
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(result)
}

func openRepositoryStore(configPath string, issuing bool, clock func() time.Time) (*localOwnerSession, *repository.BindingStore, func(), error) {
	fail := func(err error) (*localOwnerSession, *repository.BindingStore, func(), error) {
		return nil, nil, nil, err
	}
	session, err := openLocalOwner(configPath, issuing, clock)
	if err != nil {
		return fail(err)
	}
	opened := false
	defer func() {
		if !opened {
			_ = session.Close()
		}
	}()
	var executable string
	if issuing {
		executable, err = exec.LookPath("git")
		if err != nil {
			return fail(fmt.Errorf("repository registration requires local Git"))
		}
		executable, err = filepath.Abs(executable)
		if err != nil {
			return fail(err)
		}
	}
	store, err := repository.OpenBindingStore(session.Context, session.DataDir, session.RepositoryOwner(), executable, repository.Limits{})
	if err != nil {
		return fail(err)
	}
	opened = true
	return session, store, func() { _ = store.Close(); _ = session.Close() }, nil
}

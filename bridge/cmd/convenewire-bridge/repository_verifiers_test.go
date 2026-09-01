package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"convenewire.dev/bridge/internal/verification"
)

func TestRepositoryVerifierCommandRequiresClosedConfirmedInputs(t *testing.T) {
	for _, args := range [][]string{{"verifier"}, {"verifier", "shell"}, {"verifier", "register"},
		{"verifier", "register", "--confirm", "--file", "relative"}, {"verifier", "list", "--confirm"},
		{"verifier", "list", "extra"}, {"verifier", "revoke", "--confirm", "--profile-id", "profile_verifier0001"}} {
		if err := repositoryCommand(args, &bytes.Buffer{}, time.Now); err == nil {
			t.Fatalf("accepted %v", args)
		}
	}
	if err := run([]string{"repository", "verifier", "shell"}); err == nil {
		t.Fatal("main dispatcher accepted arbitrary verifier action")
	}
}

func TestRepositoryVerifierCLIRegistersListsAndRevokesWithoutRunningCommand(t *testing.T) {
	root, configPath, data, credential := repositoryProfileFixture(t, "safe")
	executable := filepath.Join(root, "verifier")
	if err := os.Link(os.Args[0], executable); err != nil {
		t.Fatal(err)
	}
	profile := verification.ProfileSpec{ProfileID: "profile_verifier0001", Revision: 1,
		Command: []string{executable, "must-not-run"}, EnvironmentNames: []string{"PATH"},
		TimeoutMilliseconds: 1000, OutputLimitBytes: 4096}
	profileFile := filepath.Join(root, "verifier.json")
	raw, _ := json.Marshal(profile)
	if err := os.WriteFile(profileFile, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 1, 16, 0, 0, 0, time.UTC)
	invoke := func(args ...string) (string, error) {
		var output bytes.Buffer
		err := repositoryCommand(append(args, "--config", configPath), &output, func() time.Time { return now })
		if strings.Contains(output.String(), root) || strings.Contains(output.String(), credential.Token) ||
			strings.Contains(output.String(), "must-not-run") {
			t.Fatal("verifier inventory exposed command, path or credential")
		}
		return output.String(), err
	}
	registered, err := invoke("verifier", "register", "--confirm", "--file", profileFile)
	if err != nil {
		t.Fatal(err)
	}
	var view verification.ProfileView
	if json.Unmarshal([]byte(registered), &view) != nil || view.Digest == "" || view.Revision != 1 {
		t.Fatal(registered)
	}
	replay, err := invoke("verifier", "register", "--confirm", "--file", profileFile)
	if err != nil || replay != registered {
		t.Fatalf("changed registration replay: %v %s", err, replay)
	}
	listed, err := invoke("verifier", "list")
	if err != nil || !strings.Contains(listed, view.Digest) {
		t.Fatalf("list=%s err=%v", listed, err)
	}
	revoked, err := invoke("verifier", "revoke", "--confirm", "--profile-id", view.ProfileID,
		"--expected-revision", "1", "--expected-digest", view.Digest)
	if err != nil || json.Unmarshal([]byte(revoked), &view) != nil || view.RevokedAt == nil {
		t.Fatalf("revoke=%s err=%v", revoked, err)
	}
	if _, err := os.Stat(filepath.Join(data, "inbox")); !os.IsNotExist(err) {
		t.Fatal("verifier administration started Run machinery")
	}
}

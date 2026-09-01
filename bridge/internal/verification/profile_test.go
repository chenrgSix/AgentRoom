package verification

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestProfileStoreRetainsResolvesRevokesAndDetectsExecutableChange(t *testing.T) {
	dataDir := filepath.Join(t.TempDir(), "data")
	if err := os.Mkdir(dataDir, 0o700); err != nil {
		t.Fatal(err)
	}
	executable := filepath.Join(t.TempDir(), "verifier")
	if err := os.WriteFile(executable, []byte("verification executable v1"), 0o700); err != nil {
		t.Fatal(err)
	}
	owner := testOwner()
	store, err := OpenProfileStore(dataDir, owner)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	now := time.Date(2026, 9, 1, 8, 0, 0, 123, time.UTC)
	spec := ProfileSpec{ProfileID: "profile_verification0001", Revision: 1,
		Command: []string{executable, "--exact", "candidate"}, EnvironmentNames: []string{"PATH", "LANG"},
		TimeoutMilliseconds: 1500, OutputLimitBytes: 4096}
	view, err := store.Register(spec, now)
	if err != nil {
		t.Fatal(err)
	}
	if view.Digest == "" || view.ExecutableDigest == "" || view.CommandDigest == "" || view.RevokedAt != nil ||
		view.RegisteredAt != now.Format(time.RFC3339Nano) {
		t.Fatalf("unexpected profile view: %#v", view)
	}
	replay, err := store.Register(spec, now.Add(time.Minute))
	if err != nil || !reflect.DeepEqual(replay, view) {
		t.Fatalf("exact retry changed immutable profile: %#v %v", replay, err)
	}
	resolved, err := store.Resolve(Reference{ProfileID: view.ProfileID, Revision: view.Revision, Digest: view.Digest})
	if err != nil || resolved.Executable != executable || resolved.Timeout != 1500*time.Millisecond ||
		len(resolved.Arguments) != 2 || resolved.Arguments[0] != "--exact" {
		t.Fatalf("unexpected resolution: %#v %v", resolved, err)
	}
	if _, err := store.Resolve(Reference{ProfileID: view.ProfileID, Revision: 1,
		Digest: strings.Repeat("f", 64)}); !errors.Is(err, ErrProfileConflict) {
		t.Fatalf("changed pin was not rejected: %v", err)
	}
	if err := os.WriteFile(executable, []byte("verification executable v2"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Resolve(Reference{ProfileID: view.ProfileID, Revision: 1,
		Digest: view.Digest}); !errors.Is(err, ErrProfileChanged) {
		t.Fatalf("changed executable was not rejected: %v", err)
	}
	revoked, err := store.Revoke(view.ProfileID, 1, view.Digest, now.Add(2*time.Minute))
	if err != nil || revoked.RevokedAt == nil {
		t.Fatalf("profile revocation failed: %#v %v", revoked, err)
	}
	if _, err := store.Resolve(Reference{ProfileID: view.ProfileID, Revision: 1,
		Digest: view.Digest}); !errors.Is(err, ErrProfileRevoked) {
		t.Fatalf("revoked profile resolved: %v", err)
	}
}

func TestProfileSpecDecodeIsClosedAndCanonical(t *testing.T) {
	executable := "/bin/sh"
	if runtime.GOOS == "windows" {
		executable = `C:\\Windows\\System32\\cmd.exe`
	}
	valid := `{"profileId":"profile_verification0002","revision":1,"command":["` +
		strings.ReplaceAll(executable, `\`, `\\`) + `","--version"],"environmentNames":[],` +
		`"timeoutMilliseconds":1000,"outputLimitBytes":4096}`
	if _, err := DecodeProfileSpec([]byte(valid)); err != nil {
		t.Fatal(err)
	}
	for name, value := range map[string]string{
		"unknown":    strings.Replace(valid, `"outputLimitBytes":4096`, `"outputLimitBytes":4096,"env":{"TOKEN":"secret"}`, 1),
		"duplicate":  strings.Replace(valid, `"revision":1`, `"revision":1,"revision":1`, 1),
		"unsafe env": strings.Replace(valid, `"environmentNames":[]`, `"environmentNames":["GITHUB_TOKEN"]`, 1),
		"relative":   strings.Replace(valid, strings.ReplaceAll(executable, `\`, `\\`), "verifier", 1),
		"trailing":   valid + `{}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := DecodeProfileSpec([]byte(value)); err == nil {
				t.Fatal("invalid profile spec was accepted")
			}
		})
	}
}

func testOwner() Owner {
	return Owner{ServerURL: "https://central.example.test", TeamID: "team_verification0001",
		DeviceID: "device_verification0001", OwnerMemberID: "member_verification0001"}
}

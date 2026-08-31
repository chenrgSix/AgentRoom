package repository

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

var bindingNow = time.Date(2026, 9, 1, 12, 0, 0, 123, time.UTC)

func bindingOwner() BindingOwner {
	return BindingOwner{ServerURL: "https://central.example.invalid", TeamID: "team_binding0001",
		DeviceID: "device_binding0001", OwnerMemberID: "member_binding0001"}
}

func bindingFixture(t *testing.T, format string) (*fixture, *BindingStore, BindRepository) {
	t.Helper()
	f := gitFixture(t, format, Limits{})
	data := filepath.Join(f.root, "bridge-data")
	if err := os.Mkdir(data, 0o700); err != nil {
		t.Fatal(err)
	}
	store, err := OpenBindingStore(context.Background(), data, bindingOwner(), f.executable, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Error(err)
		}
	})
	return f, store, BindRepository{BindingID: "repobind_fixture0001", RepositoryID: "repo_fixture0001",
		Alias: "Owned repository", SelectedRoot: f.sourcePath, AllowedRoots: []string{f.sourcePath}}
}

func TestBindingRegistrationIsExactDurableAndDoesNotChangeGit(t *testing.T) {
	for _, format := range []string{"sha1", "sha256"} {
		t.Run(format, func(t *testing.T) {
			f, store, input := bindingFixture(t, format)
			before := f.git(t, f.sourcePath, "status", "--porcelain=v1", "--untracked-files=all")
			view, err := store.Bind(context.Background(), input, bindingNow)
			if err != nil {
				t.Fatal(err)
			}
			if view.Revision != 1 || view.RevokedAt != nil || view.BindingID != input.BindingID {
				t.Fatalf("view=%+v", view)
			}
			raw, _ := json.Marshal(view)
			if strings.Contains(string(raw), f.root) || strings.Contains(string(raw), "capability") {
				t.Fatal("inventory exposed a path or advertised execution")
			}
			if after := f.git(t, f.sourcePath, "status", "--porcelain=v1", "--untracked-files=all"); after != before {
				t.Fatalf("Git changed: %s", after)
			}
			if f.git(t, f.sourcePath, "rev-parse", "HEAD") != f.base {
				t.Fatal("registration changed HEAD")
			}
			original, err := os.ReadFile(store.path(input.BindingID, false))
			if err != nil {
				t.Fatal(err)
			}
			if err := store.Close(); err != nil {
				t.Fatal(err)
			}
			reopened, err := OpenBindingStore(context.Background(), store.dataRoot, bindingOwner(), f.executable, Limits{})
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			replay, err := reopened.Bind(context.Background(), input, bindingNow.Add(time.Hour))
			if err != nil || !reflect.DeepEqual(replay, view) {
				t.Fatalf("replay=%+v err=%v", replay, err)
			}
			current, _ := os.ReadFile(reopened.path(input.BindingID, false))
			if string(current) != string(original) {
				t.Fatal("identical replay rewrote consent")
			}
			f.write(t, "src/app.txt", "ordinary later commit\n")
			f.git(t, f.sourcePath, "add", "--all")
			f.git(t, f.sourcePath, "commit", "-m", "later")
			resolved, err := reopened.ResolveSource(context.Background(), input.BindingID, input.RepositoryID, 1)
			if err != nil || resolved != f.source {
				t.Fatalf("ordinary commits invalidated physical binding: %v", err)
			}
		})
	}
}

func TestBindingRejectsScopeExpansionAndAmbiguousInputs(t *testing.T) {
	f, store, input := bindingFixture(t, "sha1")
	if _, err := store.Bind(context.Background(), input, bindingNow); err != nil {
		t.Fatal(err)
	}
	for name, change := range map[string]func(*BindRepository){
		"alias":           func(v *BindRepository) { v.Alias = "Different" },
		"repository":      func(v *BindRepository) { v.RepositoryID = "repo_other0001" },
		"broader roots":   func(v *BindRepository) { v.AllowedRoots = []string{f.root} },
		"duplicate roots": func(v *BindRepository) { v.AllowedRoots = []string{f.sourcePath, f.sourcePath} },
		"outside root":    func(v *BindRepository) { v.AllowedRoots = []string{f.state} },
		"root filesystem": func(v *BindRepository) {
			v.AllowedRoots = []string{filepath.VolumeName(f.root) + string(filepath.Separator)}
		},
		"traversal id":       func(v *BindRepository) { v.BindingID = "../repobind_fixture0001" },
		"path alias":         func(v *BindRepository) { v.Alias = "private/path" },
		"newline alias":      func(v *BindRepository) { v.Alias = "private\npath" },
		"relative selection": func(v *BindRepository) { v.SelectedRoot = "." },
	} {
		t.Run(name, func(t *testing.T) {
			candidate := input
			change(&candidate)
			if _, err := store.Bind(context.Background(), candidate, bindingNow); err == nil {
				t.Fatal("invalid or changed consent accepted")
			}
		})
	}
	if _, err := store.ResolveSource(context.Background(), input.BindingID, "repo_foreign0001", 1); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	if _, err := store.ResolveSource(context.Background(), input.BindingID, input.RepositoryID, 2); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	views, err := store.List()
	if err != nil || len(views) != 1 {
		t.Fatalf("views=%v err=%v", views, err)
	}
}

func TestBindingRevocationSurvivesMissingSourceAndGitAndCannotBeUndone(t *testing.T) {
	f, store, input := bindingFixture(t, "sha1")
	if _, err := store.Bind(context.Background(), input, bindingNow); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(f.sourcePath, f.sourcePath+"-retained"); err != nil {
		t.Fatal(err)
	}
	withoutGit, err := OpenBindingStore(context.Background(), store.dataRoot, bindingOwner(), "", Limits{})
	if err != nil {
		t.Fatal(err)
	}
	defer withoutGit.Close()
	if _, err := withoutGit.Revoke(input.BindingID, 2, bindingNow.Add(time.Second)); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	receipt, err := withoutGit.Revoke(input.BindingID, 1, bindingNow.Add(time.Second))
	if err != nil || receipt.Revision != 2 || receipt.RevokedAt == nil {
		t.Fatalf("receipt=%v err=%v", receipt, err)
	}
	replay, err := withoutGit.Revoke(input.BindingID, 1, bindingNow.Add(time.Hour))
	if err != nil || !reflect.DeepEqual(receipt, replay) {
		t.Fatalf("revoke replay=%v err=%v", replay, err)
	}
	if err := withoutGit.Close(); err != nil {
		t.Fatal(err)
	}
	withGit, err := OpenBindingStore(context.Background(), store.dataRoot, bindingOwner(), f.executable, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	defer withGit.Close()
	if _, err := withGit.Bind(context.Background(), input, bindingNow); !errors.Is(err, ErrBindingRevoked) {
		t.Fatalf("rebind=%v", err)
	}
	if _, err := withGit.ResolveSource(context.Background(), input.BindingID, input.RepositoryID, 1); !errors.Is(err, ErrBindingRevoked) {
		t.Fatalf("resolve=%v", err)
	}
	if _, err := os.Stat(f.sourcePath + "-retained"); err != nil {
		t.Fatal("revocation removed Git data", err)
	}
}

func TestBindingIdentityNamespacesDoNotInheritConsent(t *testing.T) {
	f, store, input := bindingFixture(t, "sha1")
	if _, err := store.Bind(context.Background(), input, bindingNow); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*BindingOwner){
		"origin": func(v *BindingOwner) { v.ServerURL = "https://other.example.invalid" },
		"team":   func(v *BindingOwner) { v.TeamID = "team_other0001" },
		"device": func(v *BindingOwner) { v.DeviceID = "device_other0001" },
		"owner":  func(v *BindingOwner) { v.OwnerMemberID = "member_other0001" },
	} {
		t.Run(name, func(t *testing.T) {
			owner := bindingOwner()
			mutate(&owner)
			other, err := OpenBindingStore(context.Background(), store.dataRoot, owner, f.executable, Limits{})
			if err != nil {
				t.Fatal(err)
			}
			defer other.Close()
			views, err := other.List()
			if err != nil || len(views) != 0 {
				t.Fatalf("foreign consent visible: %v %v", views, err)
			}
			if _, err := other.ResolveSource(context.Background(), input.BindingID, input.RepositoryID, 1); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("foreign resolve=%v", err)
			}
		})
	}
}

func TestBindingReplacedSourceAndOwnerDirectoryFailClosed(t *testing.T) {
	f, store, input := bindingFixture(t, "sha1")
	if _, err := store.Bind(context.Background(), input, bindingNow); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(f.sourcePath, f.sourcePath+"-original"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(f.sourcePath, 0o700); err != nil {
		t.Fatal(err)
	}
	f.git(t, f.sourcePath, "init", "--template=", "-b", "main", ".")
	if _, err := store.ResolveSource(context.Background(), input.BindingID, input.RepositoryID, 1); !errors.Is(err, ErrChanged) {
		t.Fatalf("replacement resolve=%v", err)
	}
	if _, err := store.Bind(context.Background(), input, bindingNow); !errors.Is(err, ErrConflict) {
		t.Fatalf("replacement registration=%v", err)
	}
	if err := os.Rename(store.root, store.root+"-original"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(store.root, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := store.List(); !errors.Is(err, ErrChanged) {
		t.Fatalf("replaced authority root=%v", err)
	}
	if _, err := store.Revoke(input.BindingID, 1, bindingNow); !errors.Is(err, ErrChanged) {
		t.Fatal(err)
	}
}

func TestBindingOwnerLockAndConcurrentExactRetries(t *testing.T) {
	f, store, input := bindingFixture(t, "sha1")
	if other, err := OpenBindingStore(context.Background(), store.dataRoot, bindingOwner(), f.executable, Limits{}); err == nil {
		_ = other.Close()
		t.Fatal("competing owner entered authority store")
	}
	var wg sync.WaitGroup
	results := make(chan BindingView, 8)
	errors := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			view, err := store.Bind(context.Background(), input, bindingNow)
			results <- view
			errors <- err
		}()
	}
	wg.Wait()
	close(results)
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	var first *BindingView
	for view := range results {
		if first == nil {
			first = &view
		} else if !reflect.DeepEqual(*first, view) {
			t.Fatal("retry changed receipt")
		}
	}
	views, err := store.List()
	if err != nil || len(views) != 1 {
		t.Fatalf("views=%v err=%v", views, err)
	}
}

func TestBindingCorruptOrLinkedConsentNeverBecomesAuthority(t *testing.T) {
	for _, kind := range []string{"duplicate", "wrong case", "unknown", "trailing", "relative path", "outside metadata", "duplicate roots", "oversized", "revocation digest", "orphan revocation", "symlink", "permissions"} {
		t.Run(kind, func(t *testing.T) {
			f, store, input := bindingFixture(t, "sha1")
			if _, err := store.Bind(context.Background(), input, bindingNow); err != nil {
				t.Fatal(err)
			}
			file := store.path(input.BindingID, false)
			raw, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "duplicate":
				raw = []byte(strings.Replace(string(raw), `"version":1`, `"version":1,"version":1`, 1))
			case "wrong case":
				raw = []byte(strings.Replace(string(raw), `"bindingId"`, `"BindingId"`, 1))
			case "unknown":
				raw = append([]byte(`{"extra":true,`), raw[1:]...)
			case "trailing":
				raw = append(raw, []byte(` {}`)...)
			case "relative path", "outside metadata", "duplicate roots":
				var record bindingRecord
				if err := json.Unmarshal(raw, &record); err != nil {
					t.Fatal(err)
				}
				if kind == "relative path" {
					record.Source.Root = "relative"
				}
				if kind == "outside metadata" {
					record.Source.CommonDirectory = f.state
				}
				if kind == "duplicate roots" {
					record.AllowedRoots = append(record.AllowedRoots, record.AllowedRoots[0])
				}
				raw, _ = json.Marshal(record)
			case "oversized":
				raw = []byte(strings.Repeat(" ", (64<<10)+1))
			case "revocation digest", "orphan revocation":
				if _, err := store.Revoke(input.BindingID, 1, bindingNow); err != nil {
					t.Fatal(err)
				}
				if kind == "orphan revocation" {
					if err := os.Rename(file, filepath.Join(f.root, "retained-record")); err != nil {
						t.Fatal(err)
					}
					break
				}
				file = store.path(input.BindingID, true)
				raw, _ = os.ReadFile(file)
				var revoked bindingRevocation
				if err := json.Unmarshal(raw, &revoked); err != nil {
					t.Fatal(err)
				}
				revoked.BindingDigest = strings.Repeat("0", 64)
				raw, _ = json.Marshal(revoked)
			case "symlink":
				target := filepath.Join(f.root, "retained-record")
				if err := os.Rename(file, target); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, file); err != nil {
					t.Fatal("test requires symbolic links", err)
				}
			case "permissions":
				if runtime.GOOS == "windows" {
					return
				} // Unix mode contract only; no Windows ACL claim.
				if err := os.Chmod(file, 0o644); err != nil {
					t.Fatal(err)
				}
			}
			if kind != "symlink" && kind != "orphan revocation" && kind != "permissions" {
				if err := os.WriteFile(file, raw, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := store.List(); err == nil {
				t.Fatal("corrupt/foreign consent listed as valid")
			}
			if _, err := store.ResolveSource(context.Background(), input.BindingID, input.RepositoryID, 1); err == nil {
				t.Fatal("corrupt/foreign consent resolved")
			}
		})
	}
}

package admission

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

	"convenewire.dev/bridge/internal/config"
	localruntime "convenewire.dev/bridge/internal/runtime"
	execution "convenewire.dev/contracts/generated/go/execution"
)

var profileNow = time.Date(2026, 9, 1, 14, 0, 0, 0, time.UTC)

func TestRuntimeProfileRegistrationIsProbedDurableAndPathFree(t *testing.T) {
	store, input := profileFixture(t)
	calls := 0
	prober := func(_ context.Context, probe localruntime.CodexLocalBoundaryProbe, now time.Time) (localruntime.CodexLocalBoundaryProbeResult, error) {
		calls++
		if probe.PermissionProfile != input.Spec.PermissionProfile || !strings.HasPrefix(probe.Workspace, store.probeRoot+string(filepath.Separator)) ||
			!strings.HasPrefix(probe.OutsideRoot, store.probeRoot+string(filepath.Separator)) || probe.Workspace == probe.OutsideRoot ||
			!reflect.DeepEqual(probe.Command, input.Agent.Command) || !reflect.DeepEqual(probe.Environment, []string{"HOME=/owner"}) || now.IsZero() {
			t.Fatal("registration changed the physical probe")
		}
		return successfulBoundary(input.Spec.PermissionProfile, now), nil
	}
	first, err := store.registerCodex(context.Background(), input, profileNow, prober)
	if err != nil {
		t.Fatal(err)
	}
	if first.Spec != input.Spec || len(first.Digest) != 64 || first.RevokedAt != nil || calls != 1 {
		t.Fatalf("view=%+v calls=%d", first, calls)
	}
	raw, err := json.Marshal(first)
	if err != nil || strings.Contains(string(raw), store.probeRoot) || strings.Contains(string(raw), "HOME=/owner") || strings.Contains(string(raw), "owner-canary") {
		t.Fatalf("path-free view=%s err=%v", raw, err)
	}
	persisted, err := os.ReadFile(store.path(input.Spec.ProfileID, false))
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{store.probeRoot, input.Agent.Command[0], input.Agent.Workspace, "HOME=/owner", "owner-canary"} {
		if strings.Contains(string(persisted), secret) {
			t.Fatalf("persisted profile exposed local execution detail %q: %s", secret, persisted)
		}
	}
	replay, err := store.registerCodex(context.Background(), input, profileNow.Add(time.Minute), prober)
	if err != nil || replay != first || calls != 2 {
		t.Fatalf("replay=%+v err=%v calls=%d", replay, err, calls)
	}
	listed, err := store.List()
	if err != nil || len(listed) != 1 || listed[0] != first {
		t.Fatalf("list=%+v err=%v", listed, err)
	}
	reference := execution.ExecutionGrantSummaryRuntimeProfile{ProfileID: first.Spec.ProfileID, Revision: 1, Digest: first.Digest}
	resolved, err := store.ResolveRuntime(reference, first.Spec.AgentID, input.Agent)
	if err != nil || resolved != first {
		t.Fatalf("resolved=%+v err=%v", resolved, err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenProfileStore(context.Background(), filepath.Dir(filepath.Dir(store.root)), profileOwner())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	listed, err = reopened.List()
	if err != nil || len(listed) != 1 || listed[0] != first {
		t.Fatalf("reopened list=%+v err=%v", listed, err)
	}
}

func TestRuntimeProfileResolutionRejectsReferenceIdentityAndConfigurationDrift(t *testing.T) {
	store, input := profileFixture(t)
	view, err := store.registerCodex(context.Background(), input, profileNow, fixedProber(input.Spec.PermissionProfile))
	if err != nil {
		t.Fatal(err)
	}
	reference := execution.ExecutionGrantSummaryRuntimeProfile{ProfileID: view.Spec.ProfileID, Revision: 1, Digest: view.Digest}
	for name, change := range map[string]func(*execution.ExecutionGrantSummaryRuntimeProfile, *string, *config.AgentConfig){
		"revision": func(value *execution.ExecutionGrantSummaryRuntimeProfile, _ *string, _ *config.AgentConfig) {
			value.Revision = 2
		},
		"digest": func(value *execution.ExecutionGrantSummaryRuntimeProfile, _ *string, _ *config.AgentConfig) {
			value.Digest = strings.Repeat("f", 64)
		},
		"agent": func(_ *execution.ExecutionGrantSummaryRuntimeProfile, stableAgentID *string, _ *config.AgentConfig) {
			*stableAgentID = "agent_profile0002"
		},
		"configuration": func(_ *execution.ExecutionGrantSummaryRuntimeProfile, _ *string, agent *config.AgentConfig) {
			agent.Command = append(agent.Command, "--changed")
		},
	} {
		t.Run(name, func(t *testing.T) {
			candidate, stableAgentID, agent := reference, view.Spec.AgentID, input.Agent
			agent.Command = append([]string{}, input.Agent.Command...)
			change(&candidate, &stableAgentID, &agent)
			if _, err := store.ResolveRuntime(candidate, stableAgentID, agent); !errors.Is(err, ErrProfileDenied) {
				t.Fatalf("error=%v", err)
			}
		})
	}
	missing := reference
	missing.ProfileID = "profile_missing0001"
	if _, err := store.ResolveRuntime(missing, view.Spec.AgentID, input.Agent); err == nil {
		t.Fatal("missing Runtime profile resolved")
	}
}

func TestRuntimeProfileReplayRejectsBoundaryOrIntentDrift(t *testing.T) {
	store, input := profileFixture(t)
	prober := fixedProber(input.Spec.PermissionProfile)
	if _, err := store.registerCodex(context.Background(), input, profileNow, prober); err != nil {
		t.Fatal(err)
	}
	changed := input
	changed.Agent.Command = append(append([]string{}, input.Agent.Command...), "--extra")
	changed.Spec.ConfigurationDigest, _ = CodexConfigurationDigest(changed.Agent, changed.Spec.AgentID, changed.Spec.PermissionProfile)
	if _, err := store.registerCodex(context.Background(), changed, profileNow.Add(time.Minute), prober); !errors.Is(err, ErrProfileConflict) {
		t.Fatalf("intent drift error=%v", err)
	}
	changed = input
	if _, err := store.registerCodex(context.Background(), changed, profileNow.Add(time.Minute), func(_ context.Context, _ localruntime.CodexLocalBoundaryProbe, now time.Time) (localruntime.CodexLocalBoundaryProbeResult, error) {
		result := successfulBoundary(input.Spec.PermissionProfile, now)
		result.ExecutableDigest = strings.Repeat("e", 64)
		return result, nil
	}); !errors.Is(err, ErrProfileConflict) {
		t.Fatalf("boundary drift error=%v", err)
	}
}

func TestRuntimeProfileRevocationOnlyReducesAuthority(t *testing.T) {
	store, input := profileFixture(t)
	view, err := store.registerCodex(context.Background(), input, profileNow, fixedProber(input.Spec.PermissionProfile))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Revoke(input.Spec.ProfileID, 2, view.Digest, profileNow.Add(time.Minute)); !errors.Is(err, ErrProfileConflict) {
		t.Fatal(err)
	}
	if _, err := store.Revoke(input.Spec.ProfileID, 1, strings.Repeat("0", 64), profileNow.Add(time.Minute)); !errors.Is(err, ErrProfileConflict) {
		t.Fatal(err)
	}
	if _, err := store.Revoke(input.Spec.ProfileID, 1, view.Digest, profileNow.Add(-time.Minute)); !errors.Is(err, ErrProfileInvalid) {
		t.Fatal(err)
	}
	revoked, err := store.Revoke(input.Spec.ProfileID, 1, view.Digest, profileNow.Add(time.Minute))
	if err != nil || revoked.RevokedAt == nil || revoked.Digest != view.Digest {
		t.Fatalf("revoked=%+v err=%v", revoked, err)
	}
	replay, err := store.Revoke(input.Spec.ProfileID, 1, view.Digest, profileNow.Add(2*time.Minute))
	if err != nil || !reflect.DeepEqual(replay, revoked) {
		t.Fatalf("replay=%+v err=%v", replay, err)
	}
	reference := execution.ExecutionGrantSummaryRuntimeProfile{ProfileID: view.Spec.ProfileID, Revision: 1, Digest: view.Digest}
	if _, err := store.ResolveRuntime(reference, view.Spec.AgentID, input.Agent); !errors.Is(err, ErrProfileRevoked) {
		t.Fatal(err)
	}
	if _, err := store.registerCodex(context.Background(), input, profileNow.Add(3*time.Minute), func(context.Context, localruntime.CodexLocalBoundaryProbe, time.Time) (localruntime.CodexLocalBoundaryProbeResult, error) {
		t.Fatal("revoked profile started a physical probe")
		return localruntime.CodexLocalBoundaryProbeResult{}, nil
	}); !errors.Is(err, ErrProfileRevoked) {
		t.Fatal(err)
	}
}

func TestRuntimeProfileRegistrationRejectsUnprovenOrInvalidInputs(t *testing.T) {
	store, input := profileFixture(t)
	for name, change := range map[string]func(*CodexRegistration){
		"profile id":           func(v *CodexRegistration) { v.Spec.ProfileID = "../profile_private" },
		"revision":             func(v *CodexRegistration) { v.Spec.Revision = 2 },
		"agent":                func(v *CodexRegistration) { v.Spec.AgentID = "agent_short" },
		"runtime kind":         func(v *CodexRegistration) { v.Spec.RuntimeKind = "generic" },
		"configuration digest": func(v *CodexRegistration) { v.Spec.ConfigurationDigest = strings.Repeat("A", 64) },
		"profile name":         func(v *CodexRegistration) { v.Spec.PermissionProfile = ":workspace" },
		"agent mismatch": func(v *CodexRegistration) {
			v.Agent.Command = append(append([]string{}, v.Agent.Command...), "--different")
		},
	} {
		t.Run(name, func(t *testing.T) {
			value := input
			change(&value)
			if _, err := store.registerCodex(context.Background(), value, profileNow, fixedProber(value.Spec.PermissionProfile)); !errors.Is(err, ErrProfileInvalid) {
				t.Fatalf("error=%v", err)
			}
		})
	}
	for name, change := range map[string]func(*localruntime.CodexLocalBoundaryProbeResult){
		"executable": func(v *localruntime.CodexLocalBoundaryProbeResult) { v.ExecutableDigest = "bad" },
		"permission": func(v *localruntime.CodexLocalBoundaryProbeResult) { v.PermissionProfileDigest = "bad" },
		"filesystem": func(v *localruntime.CodexLocalBoundaryProbeResult) { v.FilesystemBoundary = "unknown" },
		"network":    func(v *localruntime.CodexLocalBoundaryProbeResult) { v.NetworkBoundary = "unknown" },
		"platform":   func(v *localruntime.CodexLocalBoundaryProbeResult) { v.Platform = "linux/amd64" },
		"profile":    func(v *localruntime.CodexLocalBoundaryProbeResult) { v.PermissionProfile = "other" },
		"probe time": func(v *localruntime.CodexLocalBoundaryProbeResult) {
			v.ProbedAt = profileNow.Add(-time.Minute).Format(time.RFC3339Nano)
		},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := store.registerCodex(context.Background(), input, profileNow, func(_ context.Context, _ localruntime.CodexLocalBoundaryProbe, now time.Time) (localruntime.CodexLocalBoundaryProbeResult, error) {
				result := successfulBoundary(input.Spec.PermissionProfile, now)
				change(&result)
				return result, nil
			}); !errors.Is(err, ErrProfileDenied) {
				t.Fatalf("error=%v", err)
			}
		})
	}
	probeFailure := errors.New("physical probe failed")
	if _, err := store.registerCodex(context.Background(), input, profileNow, func(context.Context, localruntime.CodexLocalBoundaryProbe, time.Time) (localruntime.CodexLocalBoundaryProbeResult, error) {
		return localruntime.CodexLocalBoundaryProbeResult{}, probeFailure
	}); !errors.Is(err, probeFailure) {
		t.Fatal(err)
	}
	listed, err := store.List()
	if err != nil || len(listed) != 0 {
		t.Fatalf("invalid registration mutated store: %+v %v", listed, err)
	}
}

func TestRuntimeProfileStoreRejectsOwnerAndRecordCorruption(t *testing.T) {
	store, input := profileFixture(t)
	view, err := store.registerCodex(context.Background(), input, profileNow, fixedProber(input.Spec.PermissionProfile))
	if err != nil {
		t.Fatal(err)
	}
	otherOwner := profileOwner()
	otherOwner.DeviceID = "device_profileother01"
	other, err := OpenProfileStore(context.Background(), filepath.Dir(filepath.Dir(store.root)), otherOwner)
	if err == nil {
		_ = other.Close()
		t.Fatal("second store bypassed the process owner")
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	other, err = OpenProfileStore(context.Background(), filepath.Dir(filepath.Dir(store.root)), otherOwner)
	if err != nil {
		t.Fatal(err)
	}
	listed, err := other.List()
	if err != nil || len(listed) != 0 {
		t.Fatalf("cross-owner profiles=%+v err=%v", listed, err)
	}
	if err := other.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenProfileStore(context.Background(), filepath.Dir(filepath.Dir(store.root)), profileOwner())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	path := reopened.path(view.Spec.ProfileID, false)
	if runtime.GOOS != "windows" {
		if err := os.Chmod(path, 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := reopened.List(); !errors.Is(err, ErrProfileChanged) {
			t.Fatalf("public record error=%v", err)
		}
		if err := os.Chmod(path, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	orphan := reopened.path("profile_orphan0001", true)
	if err := os.WriteFile(orphan, []byte(`{"profileId":"profile_orphan0001","digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","revision":2,"revokedAt":"2026-09-01T14:00:00.000000000Z"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := reopened.List(); !errors.Is(err, ErrProfileChanged) {
		t.Fatalf("orphan revocation error=%v", err)
	}
}

func TestRuntimeProfileStoreRejectsPinnedDirectoryReplacement(t *testing.T) {
	store, input := profileFixture(t)
	if _, err := store.registerCodex(context.Background(), input, profileNow, fixedProber(input.Spec.PermissionProfile)); err != nil {
		t.Fatal(err)
	}
	_, err := store.registerCodex(context.Background(), input, profileNow.Add(time.Minute), func(_ context.Context, _ localruntime.CodexLocalBoundaryProbe, now time.Time) (localruntime.CodexLocalBoundaryProbeResult, error) {
		moved := store.root + ".replaced"
		if err := os.Rename(store.root, moved); err != nil {
			t.Skipf("directory replacement is unavailable on this platform: %v", err)
		}
		if err := os.Mkdir(store.root, 0o700); err != nil {
			t.Fatal(err)
		}
		return successfulBoundary(input.Spec.PermissionProfile, now), nil
	})
	if !errors.Is(err, ErrProfileChanged) {
		t.Fatalf("replacement error=%v", err)
	}
}

func TestRuntimeProfileStoreRejectsDisguisedPendingState(t *testing.T) {
	store, _ := profileFixture(t)
	if err := os.Mkdir(filepath.Join(store.root, ".pending-hidden"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := store.List(); !errors.Is(err, ErrProfileChanged) {
		t.Fatalf("disguised pending state error=%v", err)
	}
}

func TestRuntimeProfileStoreSerializesConcurrentExactReplay(t *testing.T) {
	store, input := profileFixture(t)
	var wait sync.WaitGroup
	views := make(chan RuntimeProfileView, 8)
	errorsSeen := make(chan error, 8)
	for index := 0; index < 8; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			view, err := store.registerCodex(context.Background(), input, profileNow, fixedProber(input.Spec.PermissionProfile))
			views <- view
			errorsSeen <- err
		}()
	}
	wait.Wait()
	close(views)
	close(errorsSeen)
	var expected RuntimeProfileView
	for err := range errorsSeen {
		if err != nil {
			t.Fatal(err)
		}
	}
	for view := range views {
		if expected.Digest == "" {
			expected = view
		} else if view != expected {
			t.Fatalf("concurrent replay changed view: %+v != %+v", view, expected)
		}
	}
}

func profileFixture(t *testing.T) (*ProfileStore, CodexRegistration) {
	t.Helper()
	t.Setenv("HOME", "/owner")
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	store, err := OpenProfileStore(context.Background(), root, profileOwner())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	workspace := filepath.Join(root, "ordinary-workspace")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	agent := config.AgentConfig{Name: "Builder", Role: "Builder", Adapter: "codex", RuntimeKind: "codex", PresetVersion: config.CurrentPresetVersion,
		Command: []string{"/Applications/Codex.app/codex", "app-server", "--listen", "stdio://"}, Workspace: workspace,
		Sandbox: "workspace-write", CodexSessionConflictPolicy: config.CodexSessionConflictPreserveAndRetry, EnvAllowlist: []string{"HOME"}}
	configurationDigest, err := CodexConfigurationDigest(agent, "agent_profile0001", "convenewire_governed")
	if err != nil {
		t.Fatal(err)
	}
	input := CodexRegistration{Spec: RuntimeProfileSpec{ProfileID: "profile_runtime0001", Revision: 1,
		AgentID: "agent_profile0001", RuntimeKind: CodexRuntimeKind, ConfigurationDigest: configurationDigest, PermissionProfile: "convenewire_governed"},
		Agent: agent}
	return store, input
}

func profileOwner() Owner {
	return Owner{ServerURL: "http://127.0.0.1:3000", TeamID: "team_profile0001", DeviceID: "device_profile0001", OwnerMemberID: "member_profile0001"}
}

func fixedProber(permission string) codexBoundaryProber {
	return func(_ context.Context, _ localruntime.CodexLocalBoundaryProbe, now time.Time) (localruntime.CodexLocalBoundaryProbeResult, error) {
		return successfulBoundary(permission, now), nil
	}
}

func successfulBoundary(permission string, now time.Time) localruntime.CodexLocalBoundaryProbeResult {
	return localruntime.CodexLocalBoundaryProbeResult{ExecutableDigest: strings.Repeat("a", 64), PermissionProfile: permission,
		PermissionProfileDigest: strings.Repeat("b", 64), FilesystemBoundary: FilesystemBoundaryName,
		NetworkBoundary: NetworkBoundaryName, ProbedAt: now.UTC().Format(time.RFC3339Nano), Platform: "darwin/arm64"}
}

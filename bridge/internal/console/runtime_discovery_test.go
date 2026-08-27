package console

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
)

func discoveryFile(t *testing.T, path string, mode os.FileMode) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	// Not a runnable script: discovering it must not execute or probe it.
	if err := os.WriteFile(path, []byte("discovery fixture only"), mode); err != nil {
		t.Fatal(err)
	}
	return path
}

func missingRuntime(string) (string, error) { return "", os.ErrNotExist }

func TestRuntimeDiscoveryPrefersPATHAndUsesAppFallback(t *testing.T) {
	directory := t.TempDir()
	pathBinary := discoveryFile(t, filepath.Join(directory, "bin", "codex"), 0o700)
	appBinary := discoveryFile(t, filepath.Join(directory, "Applications", "ChatGPT.app", "Contents", "Resources", "codex"), 0o700)
	candidates := []executableCandidate{{appBinary, "macOS App"}}
	fromPath := discoverRuntimeFrom("codex", runtime.GOOS, candidates, func(string) (string, error) { return pathBinary, nil })
	if fromPath.Path != pathBinary || fromPath.Source != "PATH" {
		t.Fatalf("PATH priority changed: %#v", fromPath)
	}
	fromApp := discoverRuntimeFrom("codex", runtime.GOOS, candidates, missingRuntime)
	if fromApp.Path != appBinary || fromApp.Source != "macOS App" {
		t.Fatalf("desktop fallback missing: %#v", fromApp)
	}
	if result := discoverRuntimeFrom("unexpected", runtime.GOOS, candidates, missingRuntime); result.Path != "" {
		t.Fatal("unrecognized Runtime was discovered")
	}
}

func TestRuntimeDiscoveryRejectsInvalidCandidatesAndPreservesSymlinkInstalls(t *testing.T) {
	directory := t.TempDir()
	file := discoveryFile(t, filepath.Join(directory, "not-executable"), 0o600)
	missing := filepath.Join(directory, "missing")
	for _, path := range []string{"relative/codex", file, directory, missing} {
		if result := discoverRuntimeFrom("codex", runtime.GOOS, []executableCandidate{{path, "test"}}, func(string) (string, error) { return path, nil }); result.Path != "" {
			t.Fatalf("invalid executable accepted: %s", path)
		}
	}
	real := discoveryFile(t, filepath.Join(directory, "real-codex"), 0o700)
	link := filepath.Join(directory, "codex")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	if result := discoverRuntimeFrom("codex", runtime.GOOS, []executableCandidate{{link, "user bin"}}, missingRuntime); result.Path != link {
		t.Fatal("normal symlink installation was rejected")
	}
}

func TestWindowsRuntimeDiscoveryAcceptsCommandShimsWithoutUnixExecuteBits(t *testing.T) {
	directory := t.TempDir()
	commandShim := discoveryFile(t, filepath.Join(directory, "codex.cmd"), 0o600)
	result := discoverRuntimeFrom("codex", "windows", nil, func(string) (string, error) {
		return commandShim, nil
	})
	if result.Path != commandShim || result.Source != "PATH" {
		t.Fatalf("Windows command shim was not discovered: %#v", result)
	}
	unsupported := discoveryFile(t, filepath.Join(directory, "codex.ps1"), 0o700)
	if result := discoverRuntimeFrom("codex", "windows", []executableCandidate{{unsupported, "test"}}, func(string) (string, error) {
		return unsupported, nil
	}); result.Path != "" {
		t.Fatalf("unsupported Windows launcher was discovered: %#v", result)
	}
}

func TestWindowsRuntimeCandidatesIncludeNativeAndCommandLaunchers(t *testing.T) {
	directory := t.TempDir()
	candidates := runtimeCandidates("codex", "windows", "", func(name string) string {
		if name == "NVM_BIN" {
			return directory
		}
		return ""
	})
	want := map[string]bool{}
	for _, extension := range []string{".exe", ".com", ".bat", ".cmd"} {
		want[filepath.Join(directory, "codex"+extension)] = true
	}
	for _, candidate := range candidates {
		delete(want, candidate.path)
	}
	if len(want) != 0 {
		t.Fatalf("Windows Runtime candidates omitted launchers: %#v", want)
	}
}

func TestRuntimeDiscoveryIncludesKnownMacAppsAndNumericNVMOrder(t *testing.T) {
	homeDirectory := t.TempDir()
	root := filepath.Join(homeDirectory, ".nvm", "versions", "node")
	for _, version := range []string{"v9.9.9", "v22.9.0", "v22.10.0", "v24.1.0", "v24.1.0-beta", "unrelated"} {
		discoveryFile(t, filepath.Join(root, version, "bin", "codex"), 0o700)
	}
	bins := nvmVersionBins(root)
	want := []string{filepath.Join(root, "v24.1.0", "bin"), filepath.Join(root, "v22.10.0", "bin"), filepath.Join(root, "v22.9.0", "bin"), filepath.Join(root, "v9.9.9", "bin")}
	if !reflect.DeepEqual(bins, want) {
		t.Fatalf("wrong nvm order: %#v", bins)
	}
	candidates := runtimeCandidates("codex", "darwin", homeDirectory, func(string) string { return "" })
	paths := make(map[string]bool)
	var nvm []executableCandidate
	for _, candidate := range candidates {
		paths[candidate.path] = true
		if candidate.source == "nvm" {
			nvm = append(nvm, candidate)
		}
	}
	for _, expected := range []string{
		"/Applications/ChatGPT.app/Contents/Resources/codex", "/Applications/Codex.app/Contents/Resources/codex",
		"/opt/homebrew/bin/codex", "/usr/local/bin/codex", filepath.Join(homeDirectory, ".local", "bin", "codex"),
		filepath.Join(homeDirectory, "Applications", "ChatGPT.app", "Contents", "Resources", "codex"),
	} {
		if !paths[expected] {
			t.Fatalf("missing known location %s", expected)
		}
	}
	if found := discoverRuntimeFrom("codex", "darwin", nvm, missingRuntime); found.Path != filepath.Join(want[0], "codex") {
		t.Fatalf("nvm candidate not selected: %#v", found)
	}
	piCandidates := runtimeCandidates("pi", "darwin", homeDirectory, func(string) string { return "" })
	for _, candidate := range piCandidates {
		if strings.Contains(candidate.path, ".app") {
			t.Fatal("Codex app used for Pi")
		}
	}
}

func TestRuntimeDiscoveryRefreshIsAuthenticatedReadOnlyAndExplicit(t *testing.T) {
	var calls atomic.Int32
	var available atomic.Bool
	dependencies := inertDependencies()
	dependencies.DiscoverRuntime = func(kind string) RuntimeDiscovery {
		calls.Add(1)
		if !available.Load() {
			return RuntimeDiscovery{}
		}
		return RuntimeDiscovery{Path: "/detected/" + kind, Source: "PATH"}
	}
	service, _ := pairedRecoveryService(t, dependencies)
	before, err := os.ReadFile(service.options.ConfigPath)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(service.Handler())
	defer server.Close()
	if calls.Load() != 2 {
		t.Fatal("startup must discover each Runtime once")
	}
	for _, token := range []string{"wrong-token", service.Token()} {
		response := consoleRequest(t, server.URL, token, http.MethodGet, "/api/state", nil)
		response.Body.Close()
	}
	if calls.Load() != 2 {
		t.Fatal("state polling repeated discovery")
	}
	denied := consoleRequest(t, server.URL, "wrong-token", http.MethodGet, "/api/runtime-discovery", nil)
	denied.Body.Close()
	if denied.StatusCode != http.StatusUnauthorized || calls.Load() != 2 {
		t.Fatal("unauthenticated discovery was permitted")
	}
	available.Store(true)
	response := consoleRequest(t, server.URL, service.Token(), http.MethodGet, "/api/runtime-discovery", nil)
	defer response.Body.Close()
	var result map[string]RuntimeDiscovery
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || calls.Load() != 4 || result["codex"].Path != "/detected/codex" {
		t.Fatalf("explicit refresh failed: %#v", result)
	}
	state := service.State()
	state.RuntimeDiscovery["codex"] = RuntimeDiscovery{}
	if service.State().DetectedCodex != "/detected/codex" || service.State().RuntimeDiscovery["codex"].Path != "/detected/codex" {
		t.Fatal("discovery state aliases a mutable snapshot")
	}
	after, err := os.ReadFile(service.options.ConfigPath)
	if err != nil || !bytes.Equal(before, after) || service.State().BridgeRunning {
		t.Fatal("discovery mutated config or lifecycle")
	}
	// A missing refresh is a successful, empty result, never a startup action.
	available.Store(false)
	empty := consoleRequest(t, server.URL, service.Token(), http.MethodGet, "/api/runtime-discovery", nil)
	empty.Body.Close()
	if empty.StatusCode != http.StatusOK || service.State().DetectedCodex != "" {
		t.Fatal(errors.New("missing refresh retained stale detection"))
	}
}

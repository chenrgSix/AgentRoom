package runtime

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	wire "convenewire.dev/contracts/generated/go/runtime"
)

var (
	ErrCodexPermissionProfileUnsupported = errors.New("Codex filesystem permission profile is unsupported on this local Runtime")
	ErrCodexPermissionBoundary           = errors.New("Codex permission profile did not enforce the required local filesystem boundary")
	permissionProfileID                  = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]{0,63}$`)
)

// CodexFilesystemPermissionProbe is an owner-local physical check. Environment
// contains exact NAME=value entries selected by the configured Agent; nothing
// is inherited implicitly. OutsideRoot is Bridge-owned private scratch that
// must not overlap Workspace. No model turn, repository operation or network
// call is made by this probe.
type CodexFilesystemPermissionProbe struct {
	Command           []string
	Environment       []string
	Workspace         string
	OutsideRoot       string
	PermissionProfile string
	Timeout           time.Duration
}

// CodexFilesystemPermissionProbeResult contains no paths, command, environment
// or canary. A positive result proves only the tested filesystem behavior for
// this executable/profile definition on this host at this time. It is not a
// reusable authorization or proof of network isolation. Runtime admission must
// bind and rerun it immediately before starting governed work.
type CodexFilesystemPermissionProbeResult struct {
	ExecutableDigest        string `json:"executableDigest"`
	PermissionProfile       string `json:"permissionProfile"`
	PermissionProfileDigest string `json:"permissionProfileDigest"`
	ProbedAt                string `json:"probedAt"`
	Platform                string `json:"platform"`
}

type probeRPCResponse struct {
	ID     int             `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  json.RawMessage `json:"error"`
}

// ProbeCodexFilesystemPermissionProfile currently tests only native macOS.
// Other platforms fail closed until they have native physical fixtures. The
// configured profile must declare network disabled, but this probe does not
// physically establish that boundary.
func ProbeCodexFilesystemPermissionProfile(ctx context.Context, input CodexFilesystemPermissionProbe, now time.Time) (CodexFilesystemPermissionProbeResult, error) {
	var evidence CodexFilesystemPermissionProbeResult
	if runtime.GOOS != "darwin" {
		return evidence, ErrCodexPermissionProfileUnsupported
	}
	if err := validateCodexFilesystemProbeCommand(input.Command); err != nil || !permissionProfileID.MatchString(input.PermissionProfile) || now.IsZero() {
		return evidence, ErrCodexPermissionProfileUnsupported
	}
	timeout := input.Timeout
	if timeout == 0 {
		timeout = 20 * time.Second
	}
	if timeout < time.Second || timeout > time.Minute {
		return evidence, ErrCodexPermissionProfileUnsupported
	}
	workspace, err := probeDirectory(input.Workspace, false)
	if err != nil {
		return evidence, ErrCodexPermissionProfileUnsupported
	}
	outside, err := probeDirectory(input.OutsideRoot, true)
	if err != nil || probeContains(workspace, outside) || probeContains(outside, workspace) {
		return evidence, ErrCodexPermissionProfileUnsupported
	}
	environment, err := probeEnvironment(input.Environment)
	if err != nil {
		return evidence, ErrCodexPermissionProfileUnsupported
	}
	executable, err := exec.LookPath(input.Command[0])
	if err != nil {
		return evidence, ErrCodexPermissionProfileUnsupported
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil || !filepath.IsAbs(executable) {
		return evidence, ErrCodexPermissionProfileUnsupported
	}
	executableDigest, err := probeFileDigest(executable)
	if err != nil {
		return evidence, ErrCodexPermissionProfileUnsupported
	}

	insidePath, err := unusedProbePath(workspace, ".convenewire-permission-probe-")
	if err != nil {
		return evidence, ErrCodexPermissionProfileUnsupported
	}
	outsideDirectory, err := os.MkdirTemp(outside, ".convenewire-permission-probe-")
	if err != nil {
		return evidence, ErrCodexPermissionProfileUnsupported
	}
	defer os.RemoveAll(outsideDirectory)
	if filepath.Dir(outsideDirectory) != outside {
		return evidence, ErrCodexPermissionProfileUnsupported
	}
	outsideRead, outsideWrite := filepath.Join(outsideDirectory, "owner-canary"), filepath.Join(outsideDirectory, "must-not-exist")
	canary, err := randomProbeCanary()
	if err != nil || os.WriteFile(outsideRead, []byte(canary), 0o600) != nil {
		return evidence, ErrCodexPermissionProfileUnsupported
	}
	defer os.Remove(insidePath)

	processContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	commandArgs := append([]string{}, input.Command[1:]...)
	command := exec.CommandContext(processContext, executable, commandArgs...)
	command.Dir, command.Env = workspace, environment
	stdin, err := command.StdinPipe()
	if err != nil {
		return evidence, ErrCodexPermissionProfileUnsupported
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return evidence, ErrCodexPermissionProfileUnsupported
	}
	stderr := &limitedBuffer{remaining: 8_192}
	command.Stderr = stderr
	managed := configureRuntimeCommand(command)
	if err := managed.Start(); err != nil {
		return evidence, ErrCodexPermissionProfileUnsupported
	}
	processStopped := false
	defer func() {
		if !processStopped {
			cancel()
			_ = managed.Wait()
		}
	}()

	responses := make(chan probeRPCResponse, 1)
	protocolErrors := make(chan error, 1)
	go scanProbeResponses(stdout, responses, protocolErrors)
	encoder := json.NewEncoder(stdin)
	nextID := 0
	call := func(method string, params any, result any) error {
		nextID++
		if err := encoder.Encode(map[string]any{"id": nextID, "method": method, "params": params}); err != nil {
			return err
		}
		select {
		case response := <-responses:
			if response.ID != nextID || len(response.Error) != 0 && string(response.Error) != "null" || len(response.Result) == 0 {
				return ErrCodexPermissionBoundary
			}
			if result != nil && json.Unmarshal(response.Result, result) != nil {
				return ErrCodexPermissionBoundary
			}
			return nil
		case <-protocolErrors:
			return ErrCodexPermissionBoundary
		case <-processContext.Done():
			return ErrCodexPermissionBoundary
		}
	}
	if err := call("initialize", map[string]any{"clientInfo": map[string]string{"name": "convenewire_permission_probe", "version": "1"}, "capabilities": map[string]bool{"experimentalApi": true}}, &map[string]any{}); err != nil {
		return evidence, err
	}
	if err := encoder.Encode(map[string]any{"method": "initialized", "params": map[string]any{}}); err != nil {
		return evidence, ErrCodexPermissionBoundary
	}

	var listed struct {
		Data []struct {
			ID      string `json:"id"`
			Allowed bool   `json:"allowed"`
		} `json:"data"`
	}
	if err := call("permissionProfile/list", map[string]any{"cwd": workspace}, &listed); err != nil {
		return evidence, err
	}
	found, allowed := 0, false
	for _, profile := range listed.Data {
		if profile.ID == input.PermissionProfile {
			found++
			allowed = profile.Allowed
		}
	}
	if found != 1 || !allowed {
		return evidence, ErrCodexPermissionBoundary
	}
	var configured struct {
		Config struct {
			Permissions map[string]json.RawMessage `json:"permissions"`
		} `json:"config"`
	}
	if err := call("config/read", map[string]any{"cwd": workspace, "includeLayers": false}, &configured); err != nil {
		return evidence, err
	}
	definition := configured.Config.Permissions[input.PermissionProfile]
	if !strictCodexPermissionDefinition(definition) {
		return evidence, ErrCodexPermissionBoundary
	}
	canonical, err := wire.CanonicalExecutionJSON(definition)
	if err != nil {
		return evidence, ErrCodexPermissionBoundary
	}
	profileHash := sha256.Sum256(canonical)

	execCall := func(arguments []string) (int, string, error) {
		var result struct {
			ExitCode int    `json:"exitCode"`
			Stdout   string `json:"stdout"`
		}
		err := call("command/exec", map[string]any{"command": arguments, "cwd": workspace, "permissionProfile": input.PermissionProfile, "timeoutMs": 3000, "outputBytesCap": 4096}, &result)
		return result.ExitCode, result.Stdout, err
	}
	insideExit, _, err := execCall([]string{"/bin/sh", "-c", `printf permitted > "$1"`, "probe", insidePath})
	if err != nil || insideExit != 0 {
		return evidence, ErrCodexPermissionBoundary
	}
	inside, err := os.ReadFile(insidePath)
	if err != nil || string(inside) != "permitted" {
		return evidence, ErrCodexPermissionBoundary
	}
	readExit, readOutput, err := execCall([]string{"/bin/cat", outsideRead})
	if err != nil || readExit == 0 || strings.Contains(readOutput, canary) {
		return evidence, ErrCodexPermissionBoundary
	}
	writeExit, _, err := execCall([]string{"/bin/sh", "-c", `printf forbidden > "$1"`, "probe", outsideWrite})
	if err != nil || writeExit == 0 {
		return evidence, ErrCodexPermissionBoundary
	}
	if _, err := os.Lstat(outsideWrite); !errors.Is(err, os.ErrNotExist) {
		return evidence, ErrCodexPermissionBoundary
	}
	currentCanary, err := os.ReadFile(outsideRead)
	if err != nil || string(currentCanary) != canary {
		return evidence, ErrCodexPermissionBoundary
	}
	cancel()
	_ = managed.Wait()
	processStopped = true
	if err := os.Remove(insidePath); err != nil {
		return evidence, ErrCodexPermissionBoundary
	}
	if err := os.RemoveAll(outsideDirectory); err != nil {
		return evidence, ErrCodexPermissionBoundary
	}
	if _, err := os.Lstat(outsideDirectory); !errors.Is(err, os.ErrNotExist) {
		return evidence, ErrCodexPermissionBoundary
	}

	return CodexFilesystemPermissionProbeResult{ExecutableDigest: executableDigest, PermissionProfile: input.PermissionProfile,
		PermissionProfileDigest: hex.EncodeToString(profileHash[:]), ProbedAt: now.UTC().Format(time.RFC3339Nano), Platform: runtime.GOOS + "/" + runtime.GOARCH}, nil
}

func scanProbeResponses(reader io.Reader, responses chan<- probeRPCResponse, failures chan<- error) {
	limited := &io.LimitedReader{R: reader, N: 1<<20 + 1}
	scanner := bufio.NewScanner(limited)
	scanner.Buffer(make([]byte, 64<<10), 1<<20)
	for scanner.Scan() {
		var envelope map[string]json.RawMessage
		if json.Unmarshal(scanner.Bytes(), &envelope) != nil {
			failures <- ErrCodexPermissionBoundary
			return
		}
		if _, ok := envelope["id"]; !ok {
			continue
		}
		var response probeRPCResponse
		if json.Unmarshal(scanner.Bytes(), &response) != nil || response.ID == 0 {
			failures <- ErrCodexPermissionBoundary
			return
		}
		select {
		case responses <- response:
		default:
			failures <- ErrCodexPermissionBoundary
			return
		}
	}
	if err := scanner.Err(); err != nil {
		failures <- err
		return
	}
	if limited.N == 0 {
		failures <- ErrCodexPermissionBoundary
		return
	}
	failures <- io.EOF
}

func strictCodexPermissionDefinition(raw []byte) bool {
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return false
	}
	var profile map[string]json.RawMessage
	if json.Unmarshal(raw, &profile) != nil || !jsonNull(profile["extends"]) || !jsonNull(profile["workspace_roots"]) {
		return false
	}
	for key := range profile {
		switch key {
		case "description", "extends", "workspace_roots", "filesystem", "network":
		default:
			return false
		}
	}
	var filesystem map[string]json.RawMessage
	if json.Unmarshal(profile["filesystem"], &filesystem) != nil {
		return false
	}
	for key, value := range filesystem {
		switch key {
		case ":root", ":tmpdir", ":slash_tmp":
			if string(value) != `"deny"` {
				return false
			}
		case ":minimal":
			if string(value) != `"read"` {
				return false
			}
		case "glob_scan_max_depth":
			if !jsonNull(value) {
				return false
			}
		case ":workspace_roots":
			var roots map[string]string
			if json.Unmarshal(value, &roots) != nil || len(roots) != 1 || roots["."] != "write" {
				return false
			}
		default:
			return false
		}
	}
	for _, key := range []string{":root", ":tmpdir", ":slash_tmp", ":minimal", ":workspace_roots"} {
		if _, ok := filesystem[key]; !ok {
			return false
		}
	}
	var network map[string]json.RawMessage
	if json.Unmarshal(profile["network"], &network) != nil || string(network["enabled"]) != "false" {
		return false
	}
	for key, value := range network {
		if key != "enabled" && !jsonNull(value) {
			return false
		}
	}
	return true
}

func validateCodexFilesystemProbeCommand(command []string) error {
	if err := validateCodexCommand(command); err != nil || filepath.Base(command[0]) != "codex" {
		return ErrCodexPermissionProfileUnsupported
	}
	appServer, stdio := 0, 0
	for index, argument := range command[1:] {
		switch argument {
		case "app-server":
			appServer++
		case "--listen":
			resolved := index + 2
			if resolved >= len(command) || command[resolved] != "stdio://" {
				return ErrCodexPermissionProfileUnsupported
			}
			stdio++
		}
	}
	if appServer != 1 || stdio != 1 {
		return ErrCodexPermissionProfileUnsupported
	}
	return nil
}

func jsonNull(raw json.RawMessage) bool { return len(raw) == 0 || bytes.Equal(raw, []byte("null")) }

func probeDirectory(path string, private bool) (string, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return "", ErrCodexPermissionProfileUnsupported
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil || resolved != path || filepath.Dir(path) == path {
		return "", ErrCodexPermissionProfileUnsupported
	}
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || private && info.Mode().Perm()&0o077 != 0 {
		return "", ErrCodexPermissionProfileUnsupported
	}
	return path, nil
}

func probeContains(root, path string) bool {
	relative, err := filepath.Rel(root, path)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func probeEnvironment(values []string) ([]string, error) {
	result, seen := append([]string{}, values...), map[string]bool{}
	safe := map[string]bool{"HOME": true, "PATH": true, "CODEX_HOME": true, "LANG": true, "LC_ALL": true, "LC_CTYPE": true, "TERM": true}
	for _, value := range result {
		name, _, ok := strings.Cut(value, "=")
		if !ok || name == "" || seen[name] || !safe[name] || strings.ContainsAny(name, "\x00=\r\n") {
			return nil, ErrCodexPermissionProfileUnsupported
		}
		seen[name] = true
	}
	return result, nil
}

func unusedProbePath(root, pattern string) (string, error) {
	file, err := os.CreateTemp(root, pattern)
	if err != nil {
		return "", err
	}
	path := file.Name()
	if err := file.Close(); err != nil {
		_ = os.Remove(path)
		return "", err
	}
	if err := os.Remove(path); err != nil {
		return "", err
	}
	return path, nil
}

func randomProbeCanary() (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}

func probeFileDigest(path string) (string, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > 1<<30 {
		return "", ErrCodexPermissionProfileUnsupported
	}
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	actual, err := file.Stat()
	if err != nil || !os.SameFile(info, actual) {
		return "", ErrCodexPermissionProfileUnsupported
	}
	hash := sha256.New()
	n, err := io.Copy(hash, io.LimitReader(file, (1<<30)+1))
	if err != nil || n != info.Size() {
		return "", ErrCodexPermissionProfileUnsupported
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

package verification

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	bridgeruntime "convenewire.dev/bridge/internal/runtime"
)

type Outcome string

const (
	OutcomePassed   Outcome = "passed"
	OutcomeFailed   Outcome = "failed"
	OutcomeTimeout  Outcome = "timed_out"
	OutcomeCanceled Outcome = "canceled"
	OutcomeUnknown  Outcome = "outcome_unknown"
)

type Result struct {
	Outcome              Outcome
	ExitCode             *int
	StartedAt            time.Time
	FinishedAt           time.Time
	DurationMilliseconds int64
	Log                  []byte
}

type Runner struct {
	TemporaryParent string
	Now             func() time.Time
}

type boundedBuffer struct {
	mu       sync.Mutex
	buffer   bytes.Buffer
	limit    int64
	exceeded bool
	cancel   context.CancelFunc
}

func (b *boundedBuffer) Write(value []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	remaining := b.limit - int64(b.buffer.Len())
	if remaining <= 0 {
		b.exceeded = true
		b.cancel()
		return len(value), nil
	}
	write := value
	if int64(len(write)) > remaining {
		write = write[:remaining]
		b.exceeded = true
		b.cancel()
	}
	_, _ = b.buffer.Write(write)
	return len(value), nil
}

func (b *boundedBuffer) snapshot() ([]byte, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return bytes.Clone(b.buffer.Bytes()), b.exceeded
}

type logEnvelope struct {
	Version   int    `json:"version"`
	Stdout    string `json:"stdout"`
	Stderr    string `json:"stderr"`
	Truncated bool   `json:"truncated"`
	Spawned   bool   `json:"spawned"`
}

func (r Runner) Run(ctx context.Context, profile ResolvedProfile, workspace string) (Result, error) {
	var result Result
	if ctx == nil || profile.Executable == "" || profile.Timeout < 100*time.Millisecond ||
		profile.OutputLimitBytes < 1024 || !filepath.IsAbs(workspace) || filepath.Clean(workspace) != workspace {
		return result, ErrProfileInvalid
	}
	info, err := os.Lstat(workspace)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return result, ErrProfileChanged
	}
	err = r.WithRunRoot(ctx, func(runRoot string) error {
		var runErr error
		result, runErr = r.RunInRoot(ctx, profile, workspace, runRoot)
		return runErr
	})
	return result, err
}

// WithRunRoot guarantees one owned root and one cleanup for an entire verifier
// set. Callers may create the disposable candidate below root and run multiple
// profiles with shared task-local caches; no path escapes the callback.
func (r Runner) WithRunRoot(ctx context.Context, use func(string) error) error {
	if ctx == nil || use == nil {
		return ErrProfileInvalid
	}
	parent := r.TemporaryParent
	if parent == "" {
		parent = os.TempDir()
	}
	runRoot, err := os.MkdirTemp(parent, "convene-wire-verification-")
	if err != nil {
		return err
	}
	if err := os.Chmod(runRoot, 0o700); err != nil {
		return errors.Join(err, os.RemoveAll(runRoot))
	}
	for _, name := range []string{"home", "tmp", "gocache", "gomodcache", "npm-cache"} {
		if err := os.Mkdir(filepath.Join(runRoot, name), 0o700); err != nil {
			return errors.Join(err, os.RemoveAll(runRoot))
		}
	}
	return errors.Join(use(runRoot), os.RemoveAll(runRoot))
}

func (r Runner) RunInRoot(ctx context.Context, profile ResolvedProfile,
	workspace, runRoot string) (Result, error) {
	var result Result
	if ctx == nil || profile.Executable == "" || profile.Timeout < 100*time.Millisecond ||
		profile.OutputLimitBytes < 1024 || !filepath.IsAbs(workspace) || filepath.Clean(workspace) != workspace ||
		!filepath.IsAbs(runRoot) || filepath.Clean(runRoot) != runRoot {
		return result, ErrProfileInvalid
	}
	rootInfo, err := os.Lstat(runRoot)
	if err != nil || !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return result, ErrProfileChanged
	}
	workspaceInfo, err := os.Lstat(workspace)
	if err != nil || !workspaceInfo.IsDir() || workspaceInfo.Mode()&os.ModeSymlink != 0 {
		return result, ErrProfileChanged
	}
	currentDigest, err := executableDigest(profile.Executable)
	if err != nil || currentDigest != profile.ExecutableDigest {
		return result, ErrProfileChanged
	}
	started := r.now()
	runContext, cancel := context.WithTimeout(ctx, profile.Timeout)
	defer cancel()
	command, managed, err := bridgeruntime.NewOwnedCommand(runContext,
		append([]string{profile.Executable}, profile.Arguments...))
	if err != nil {
		return result, err
	}
	command.Dir = workspace
	command.Env = verificationEnvironment(profile.EnvironmentNames, runRoot)
	stdout := &boundedBuffer{limit: profile.OutputLimitBytes / 2, cancel: cancel}
	stderr := &boundedBuffer{limit: profile.OutputLimitBytes - profile.OutputLimitBytes/2, cancel: cancel}
	command.Stdout, command.Stderr = stdout, stderr
	result.StartedAt = started
	spawned := false
	runErr := managed.Start()
	if runErr == nil {
		spawned = true
		runErr = managed.Wait()
	}
	finished := r.now()
	result.FinishedAt = finished
	result.DurationMilliseconds = max(0, finished.Sub(started).Milliseconds())
	out, outTruncated := stdout.snapshot()
	errout, errTruncated := stderr.snapshot()
	result.Log = verificationLog(out, errout, outTruncated || errTruncated, spawned, workspace, runRoot)
	if spawned {
		var exited *exec.ExitError
		if errors.As(runErr, &exited) {
			code := exited.ExitCode()
			result.ExitCode = &code
		} else if runErr == nil {
			code := 0
			result.ExitCode = &code
		}
	}
	if outTruncated || errTruncated {
		result.Outcome = OutcomeFailed
	} else if errors.Is(runContext.Err(), context.DeadlineExceeded) {
		result.Outcome = OutcomeTimeout
	} else if errors.Is(ctx.Err(), context.Canceled) {
		result.Outcome = OutcomeCanceled
	} else if !spawned {
		result.Outcome = OutcomeFailed
	} else if runErr == nil {
		result.Outcome = OutcomePassed
	} else {
		result.Outcome = OutcomeFailed
	}
	if result.Outcome != OutcomePassed && result.Outcome != OutcomeFailed {
		result.ExitCode = nil
	}
	return result, nil
}

func (r Runner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	return time.Now().UTC()
}

func verificationEnvironment(names []string, root string) []string {
	environment := []string{
		"HOME=" + filepath.Join(root, "home"),
		"TMPDIR=" + filepath.Join(root, "tmp"),
		"GOCACHE=" + filepath.Join(root, "gocache"),
		"GOMODCACHE=" + filepath.Join(root, "gomodcache"),
		"GOFLAGS=-modcacherw",
		"npm_config_cache=" + filepath.Join(root, "npm-cache"),
		"CI=1",
	}
	for _, name := range names {
		if safeEnvironmentNames[name] {
			if value, ok := os.LookupEnv(name); ok {
				environment = append(environment, name+"="+value)
			}
		}
	}
	return environment
}

func verificationLog(stdout, stderr []byte, truncated, spawned bool, workspace, root string) []byte {
	redact := func(value []byte) string {
		text := strings.ReplaceAll(string(value), workspace, "<candidate>")
		text = strings.ReplaceAll(text, root, "<verification-temp>")
		text = strings.ReplaceAll(text, filepath.Dir(root), "<verification-parent>")
		return text
	}
	raw, _ := json.Marshal(logEnvelope{Version: 1, Stdout: redact(stdout), Stderr: redact(stderr),
		Truncated: truncated, Spawned: spawned})
	return raw
}

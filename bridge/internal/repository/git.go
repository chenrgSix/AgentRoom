// Package repository implements owner-selected bindings and local Git operations.
// It is not a wire API, Task-grant authority, Runtime launcher, or OS sandbox.
package repository

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

var (
	ErrLimit      = errors.New("repository operation exceeded its local resource limit")
	ErrInvalid    = errors.New("repository operation has invalid local input")
	ErrChanged    = errors.New("repository identity or prepared content changed")
	ErrConflict   = errors.New("repository operation identity already has different input")
	ErrIncomplete = errors.New("repository preparation is incomplete; retain it for inspection")
)

// Limits are selected locally, never by a remote Agent or request. Zero values
// select bounded defaults. SnapshotBytes counts checkout bytes, not just unique
// objects, so repeating one large blob cannot bypass the materialization limit.
type Limits struct {
	SnapshotBytes  int64
	Entries        int
	CommandTimeout time.Duration
}

func (l Limits) normalized() (Limits, error) {
	if l.SnapshotBytes == 0 {
		l.SnapshotBytes = 128 << 20
	}
	if l.Entries == 0 {
		l.Entries = 100000
	}
	if l.CommandTimeout == 0 {
		l.CommandTimeout = time.Minute
	}
	if l.SnapshotBytes < 1 || l.SnapshotBytes > 512<<20 || l.Entries < 1 || l.Entries > 100000 ||
		l.CommandTimeout < time.Millisecond || l.CommandTimeout > 5*time.Minute {
		return l, ErrInvalid
	}
	return l, nil
}

type gitRunner struct {
	executable string
	limits     Limits
}

func newGit(executable string, limits Limits) (gitRunner, error) {
	l, err := limits.normalized()
	if err != nil {
		return gitRunner{}, err
	}
	if !filepath.IsAbs(executable) {
		return gitRunner{}, ErrInvalid
	}
	info, err := os.Stat(executable)
	if err != nil || !info.Mode().IsRegular() {
		return gitRunner{}, ErrInvalid
	}
	return gitRunner{executable: executable, limits: l}, nil
}

// Preserve only process-launch essentials. In particular do not inherit Git
// config/trace/SSH/askpass/index/object-directory overrides or provider secrets.
func gitEnvironment() []string {
	env := []string{
		"GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_SYSTEM=" + os.DevNull, "GIT_CONFIG_GLOBAL=" + os.DevNull,
		"GIT_TERMINAL_PROMPT=0", "GIT_NO_REPLACE_OBJECTS=1", "GIT_NO_LAZY_FETCH=1",
		"GIT_OPTIONAL_LOCKS=0", "GIT_ATTR_NOSYSTEM=1", "GIT_LITERAL_PATHSPECS=1",
		"GIT_AUTHOR_NAME=ConveneWire", "GIT_AUTHOR_EMAIL=local@convenewire.invalid",
		"GIT_COMMITTER_NAME=ConveneWire", "GIT_COMMITTER_EMAIL=local@convenewire.invalid",
		"GIT_AUTHOR_DATE=2000-01-01T00:00:00Z", "GIT_COMMITTER_DATE=2000-01-01T00:00:00Z",
		"LC_ALL=C", "LANG=C",
	}
	for _, key := range []string{"PATH", "SystemRoot", "WINDIR"} {
		if value, ok := os.LookupEnv(key); ok {
			env = append(env, key+"="+value)
		}
	}
	return env
}

type cappedOutput struct {
	buffer   bytes.Buffer
	limit    int64
	exceeded bool
	cancel   context.CancelFunc
}

func (b *cappedOutput) Write(p []byte) (int, error) {
	if int64(len(p)) > b.limit-int64(b.buffer.Len()) {
		b.exceeded = true
		b.cancel()
		return 0, ErrLimit
	}
	return b.buffer.Write(p)
}

// Args are private fixed command arrays. No public function accepts a command,
// environment, ref expression, URL or arbitrary executable argument.
func (g gitRunner) run(ctx context.Context, directory string, input io.Reader, maxOutput int64, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, g.limits.CommandTimeout)
	defer cancel()
	fixed := []string{"--no-pager", "-c", "core.hooksPath=" + os.DevNull, "-c", "core.fsmonitor=false",
		"-c", "core.attributesFile=" + os.DevNull, "-c", "core.autocrlf=false",
		"-c", "protocol.allow=never", "-c", "credential.helper=", "-c", "gc.auto=0",
		"-c", "maintenance.auto=false", "-c", "pack.threads=1", "-c", "core.commitGraph=false"}
	command := exec.CommandContext(ctx, g.executable, append(fixed, args...)...)
	command.Dir = directory
	command.Env = gitEnvironment()
	command.Stdin = input
	stdout := &cappedOutput{limit: maxOutput, cancel: cancel}
	stderr := &cappedOutput{limit: 32 << 10, cancel: cancel}
	command.Stdout, command.Stderr = stdout, stderr
	command.WaitDelay = time.Second
	err := command.Run()
	if stdout.exceeded || stderr.exceeded {
		return nil, ErrLimit
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if err != nil {
		// Git stderr can contain local paths, repository content or credentials.
		// It deliberately never becomes a central diagnostic or a returned error.
		var exited *exec.ExitError
		if errors.As(err, &exited) {
			return nil, fmt.Errorf("repository Git %s failed (exit %d)", args[0], exited.ExitCode())
		}
		return nil, errors.New("repository Git executable unavailable")
	}
	return stdout.buffer.Bytes(), nil
}

func (g gitRunner) text(ctx context.Context, directory string, args ...string) (string, error) {
	value, err := g.run(ctx, directory, nil, 16<<10, args...)
	return strings.TrimSuffix(string(value), "\n"), err
}

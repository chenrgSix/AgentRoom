package repository

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	execution "convenewire.dev/contracts/generated/go/execution"
)

// MaterializeVerificationCandidate creates a disposable checkout from the
// sealed capture object store. The caller owns runRoot and its cleanup. This
// never reads from or mutates the owner's source checkout.
func (p *Preparer) MaterializeVerificationCandidate(ctx context.Context,
	checkpoint execution.RepositoryCheckpoint, runRoot string) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.checkOwner(); err != nil {
		return "", err
	}
	if ctx == nil || !filepath.IsAbs(runRoot) || filepath.Clean(runRoot) != runRoot {
		return "", ErrInvalid
	}
	info, err := os.Lstat(runRoot)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 ||
		(runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0) {
		return "", ErrInvalid
	}
	_, captured, _, err := p.confirmedCapture(ctx, checkpoint)
	if err != nil {
		return "", err
	}
	if captured.CandidateCommit != checkpoint.CandidateCommit ||
		captured.CandidateTree != checkpoint.CandidateTree {
		return "", ErrChanged
	}
	source := filepath.Join(p.capturePath(checkpoint.OperationID), "git")
	destination := filepath.Join(runRoot, "candidate")
	if _, err := os.Lstat(destination); !errors.Is(err, os.ErrNotExist) {
		return "", ErrConflict
	}
	// The only enabled transport is this already-confirmed capture-owned local
	// path. The global Git runner keeps every other protocol disabled.
	if _, err := p.git.run(ctx, runRoot, nil, 16<<10,
		"-c", "protocol.file.allow=always", "clone", "--no-local",
		"--no-checkout", "--", source, destination); err != nil {
		return "", err
	}
	if _, err := p.git.run(ctx, destination, nil, 16<<10, "checkout", "--detach",
		checkpoint.CandidateCommit); err != nil {
		return "", err
	}
	head, err := p.git.text(ctx, destination, "rev-parse", "HEAD")
	if err != nil || head != checkpoint.CandidateCommit {
		return "", ErrChanged
	}
	tree, err := p.git.text(ctx, destination, "rev-parse", "HEAD^{tree}")
	if err != nil || tree != checkpoint.CandidateTree {
		return "", ErrChanged
	}
	status, err := p.git.text(ctx, destination, "status", "--porcelain=v1",
		"--untracked-files=all")
	if err != nil || strings.TrimSpace(status) != "" {
		return "", ErrChanged
	}
	return destination, nil
}

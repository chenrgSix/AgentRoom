package repository

import (
	"errors"
	"sort"
	"strings"

	execution "convenewire.dev/contracts/generated/go/execution"
)

var (
	ErrScope         = errors.New("repository output exceeds the frozen path scope")
	ErrSpecialOutput = errors.New("changed symlink or submodule output is unsupported")
)

func freezeScopePolicy(policy execution.ManifestScopePolicy) (execution.ManifestScopePolicy, error) {
	if policy.Access != execution.ReadOnly && policy.Access != execution.IsolatedWrite {
		return policy, ErrInvalid
	}
	policy.AllowedPaths = append([]string{}, policy.AllowedPaths...)
	policy.ForbiddenPaths = append([]string{}, policy.ForbiddenPaths...)
	for _, paths := range [][]string{policy.AllowedPaths, policy.ForbiddenPaths} {
		if len(paths) > 64 {
			return policy, ErrLimit
		}
		seen := map[string]bool{}
		for _, path := range paths {
			if seen[path] || (path != "." && !portablePath(path)) {
				return policy, ErrInvalid
			}
			for _, part := range strings.Split(path, "/") {
				if strings.TrimSpace(part) != part {
					return policy, ErrInvalid
				}
			}
			seen[path] = true
		}
		sort.Strings(paths)
	}
	if policy.Access == execution.ReadOnly && len(policy.AllowedPaths) != 0 {
		return policy, ErrInvalid
	}
	if policy.Access == execution.IsolatedWrite {
		usable := false
		for _, path := range policy.AllowedPaths {
			if allowedOutput(policy, path) {
				usable = true
			}
		}
		if !usable {
			return policy, ErrInvalid
		}
	}
	return policy, nil
}

func prefixContains(prefix, path string) bool {
	return prefix == "." || path == prefix || strings.HasPrefix(path, prefix+"/")
}

func allowedOutput(policy execution.ManifestScopePolicy, path string) bool {
	if policy.Access != execution.IsolatedWrite {
		return false
	}
	for _, prefix := range policy.ForbiddenPaths {
		if prefixContains(prefix, path) {
			return false
		}
	}
	for _, prefix := range policy.AllowedPaths {
		if prefixContains(prefix, path) {
			return true
		}
	}
	return false
}

func (p *Preparer) checkOwner() error {
	if p.closed {
		return ErrInvalid
	}
	for path, expected := range p.directories {
		actual, err := directoryIdentity(path)
		if err != nil || actual != expected {
			return ErrChanged
		}
	}
	return nil
}

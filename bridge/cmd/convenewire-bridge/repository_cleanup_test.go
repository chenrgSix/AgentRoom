package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRepositoryCleanupCommandRequiresExactOwnerConfirmation(t *testing.T) {
	for _, args := range [][]string{
		{"cleanup"},
		{"cleanup", "shell"},
		{"cleanup", "preview"},
		{"cleanup", "preview", "--grant-id", "cleanupgrant_example001", "--operation-id", "op_cleanup_example001", "--checkpoint-file", "relative"},
		{"cleanup", "preview", "--grant-id", "grant_example001", "--operation-id", "op_cleanup_example001", "--checkpoint-file", "/missing"},
		{"cleanup", "execute", "--grant-id", "cleanupgrant_example001", "--operation-id", "op_cleanup_example001", "--checkpoint-file", "/missing", "--confirm"},
		{"cleanup", "execute", "--grant-id", "cleanupgrant_example001", "--operation-id", "op_cleanup_example001", "--checkpoint-file", "/missing", "--expected-preview-digest", "short", "--confirm"},
		{"cleanup", "grant"},
		{"cleanup", "grant", "issue"},
		{"cleanup", "grant", "issue", "--grant-id", "cleanupgrant_example001", "--operation-id", "op_cleanup_example001", "--checkpoint-file", "/missing", "--expires-at", "2026-09-02T12:00:00Z"},
		{"cleanup", "grant", "revoke", "--grant-id", "cleanupgrant_example001", "--expected-revision", "1", "--expected-digest", "digest"},
		{"cleanup", "grant", "list", "--confirm"},
		{"cleanup", "grant", "list", "extra"},
	} {
		if err := repositoryCommand(args, &bytes.Buffer{}, time.Now); err == nil {
			t.Fatalf("accepted %v", args)
		}
	}
}

func TestReadCleanupCheckpointRejectsUnsafeOrAmbiguousFiles(t *testing.T) {
	root := t.TempDir()
	valid := filepath.Join(root, "checkpoint.json")
	if err := os.WriteFile(valid, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readCleanupCheckpoint(valid); err != nil {
		t.Fatalf("bounded regular checkpoint rejected: %v", err)
	}
	linked := filepath.Join(root, "checkpoint-link.json")
	if err := os.Symlink(valid, linked); err != nil {
		t.Fatal(err)
	}
	unknown := filepath.Join(root, "unknown.json")
	if err := os.WriteFile(unknown, []byte(`{"foreign":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	trailing := filepath.Join(root, "trailing.json")
	if err := os.WriteFile(trailing, []byte("{} {}"), 0o600); err != nil {
		t.Fatal(err)
	}
	empty := filepath.Join(root, "empty.json")
	if err := os.WriteFile(empty, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	for name, path := range map[string]string{
		"relative":  "checkpoint.json",
		"symlink":   linked,
		"directory": root,
		"unknown":   unknown,
		"trailing":  trailing,
		"empty":     empty,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := readCleanupCheckpoint(path); err == nil {
				t.Fatalf("accepted %s", path)
			}
		})
	}
}

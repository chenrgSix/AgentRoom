//go:build darwin || linux

package controller

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestLifecycleLockIsExclusiveReentrantAndInstallNeutral(t *testing.T) {
	dataRoot := filepath.Join(t.TempDir(), "central")
	lockedContext, release, err := acquireLifecycleLock(context.Background(), dataRoot)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = release() }()

	if dataRootHasState(dataRoot) {
		t.Fatal("the controller-owned lock alone made an empty data root look adopted")
	}
	_, nestedRelease, err := acquireLifecycleLock(lockedContext, dataRoot)
	if err != nil {
		t.Fatalf("same-operation nested lock was not reentrant: %v", err)
	}
	if err := nestedRelease(); err != nil {
		t.Fatal(err)
	}

	_, _, err = acquireLifecycleLock(context.Background(), dataRoot)
	var action *ActionError
	if !errors.As(err, &action) || action.Code != "LIFECYCLE_BUSY" {
		t.Fatalf("second process-equivalent owner error = %v, want LIFECYCLE_BUSY", err)
	}

	if err := release(); err != nil {
		t.Fatal(err)
	}
	release = func() error { return nil }
	_, nextRelease, err := acquireLifecycleLock(context.Background(), dataRoot)
	if err != nil {
		t.Fatalf("released lifecycle lock remained busy: %v", err)
	}
	if err := nextRelease(); err != nil {
		t.Fatal(err)
	}
}

func TestLifecycleLockRejectsUnsafeExistingFile(t *testing.T) {
	dataRoot := filepath.Join(t.TempDir(), "central")
	control := filepath.Join(dataRoot, "control")
	if err := os.MkdirAll(control, 0o700); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "target")
	if err := os.WriteFile(target, []byte("not a lock"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(control, lifecycleLockFilename)); err != nil {
		t.Fatal(err)
	}

	_, _, err := acquireLifecycleLock(context.Background(), dataRoot)
	var action *ActionError
	if !errors.As(err, &action) || action.Code != "LIFECYCLE_LOCK_FAILED" {
		t.Fatalf("unsafe lifecycle lock error = %v, want LIFECYCLE_LOCK_FAILED", err)
	}
}

func TestManifestCompareAndSwapRejectsStaleMutation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "control", "installation.json")
	manifest := Manifest{
		SchemaVersion:      manifestSchemaVersion,
		Generation:         1,
		InstallationID:     "install_0123456789abcdef",
		Mode:               "local",
		TLSProfile:         "local",
		LastSuccessfulStep: "ready",
	}
	if err := saveManifest(path, manifest); err != nil {
		t.Fatal(err)
	}
	stale := manifest
	manifest.LastSuccessfulStep = "backup_ready"
	if err := saveManifestCAS(path, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Generation != 2 {
		t.Fatalf("manifest generation = %d, want 2", manifest.Generation)
	}

	stale.LastSuccessfulStep = "uninstalled"
	err := saveManifestCAS(path, &stale)
	var action *ActionError
	if !errors.As(err, &action) || action.Code != "MANIFEST_STALE" {
		t.Fatalf("stale manifest error = %v, want MANIFEST_STALE", err)
	}
	loaded, found, err := loadManifest(path)
	if err != nil || !found || loaded.LastSuccessfulStep != "backup_ready" || loaded.Generation != 2 {
		t.Fatalf("stale write changed committed manifest: found=%v manifest=%+v err=%v", found, loaded, err)
	}
}

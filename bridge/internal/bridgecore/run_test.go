package bridgecore

import (
	"context"
	"strings"
	"testing"

	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/operations"
	"convenewire.dev/bridge/internal/ownership"
	"convenewire.dev/bridge/internal/pairing"
)

func TestRunRejectsASecondCoreOwnerBeforeOpeningMutableState(t *testing.T) {
	directory := t.TempDir()
	owner, err := ownership.Acquire(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Release()
	err = RunObservedWithProvisioning(
		context.Background(),
		config.Config{DataDir: directory},
		pairing.Credential{},
		"test",
		operations.Observer{},
		nil,
	)
	if err == nil || !strings.Contains(err.Error(), "already owned") {
		t.Fatalf("second core owner was not rejected: %v", err)
	}
}

func TestRunBorrowsTheShellOwnerWithoutReleasingIt(t *testing.T) {
	directory := t.TempDir()
	owner, err := ownership.Acquire(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Release()
	ctx, cancel := context.WithCancel(ownership.WithOwner(context.Background(), owner))
	cancel()
	err = RunObservedWithProvisioning(
		ctx,
		config.Config{ServerURL: "https://team.example.com", DataDir: directory},
		pairing.Credential{ServerURL: "https://team.example.com"},
		"test",
		operations.Observer{},
		nil,
	)
	if err != nil {
		t.Fatalf("core did not borrow its shell owner: %v", err)
	}
	if second, err := ownership.Acquire(directory); err == nil {
		_ = second.Release()
		t.Fatal("core released the shell's data directory owner")
	}
}

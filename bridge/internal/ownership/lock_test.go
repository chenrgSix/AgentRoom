package ownership

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestAcquireExcludesAnotherOwnerUntilRelease(t *testing.T) {
	directory := t.TempDir()
	first, err := Acquire(directory)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Acquire(directory); err == nil {
		t.Fatal("second Bridge owner acquired the same data directory")
	}
	if err := first.Release(); err != nil {
		t.Fatal(err)
	}
	second, err := Acquire(directory)
	if err != nil {
		t.Fatalf("released Bridge data directory stayed locked: %v", err)
	}
	if err := second.Release(); err != nil {
		t.Fatal(err)
	}
}

func TestAcquireRejectsSymbolicLockFile(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(target, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(directory, lockFilename)); err != nil {
		t.Skipf("symbolic links unavailable: %v", err)
	}
	if _, err := Acquire(directory); err == nil {
		t.Fatal("symbolic Bridge owner lock was accepted")
	}
}

func TestAcquireForContextBorrowsOnlyTheExactOwner(t *testing.T) {
	directory := t.TempDir()
	owner, err := Acquire(directory)
	if err != nil {
		t.Fatal(err)
	}
	releaseBorrowed, err := AcquireForContext(WithOwner(context.Background(), owner), directory)
	if err != nil {
		t.Fatal(err)
	}
	if err := releaseBorrowed(); err != nil {
		t.Fatal(err)
	}
	if second, err := Acquire(directory); err == nil {
		_ = second.Release()
		t.Fatal("borrowed core lease released its shell owner")
	}
	otherDirectory := t.TempDir()
	releaseOther, err := AcquireForContext(WithOwner(context.Background(), owner), otherDirectory)
	if err != nil {
		t.Fatal(err)
	}
	if err := releaseOther(); err != nil {
		t.Fatal(err)
	}
	if err := owner.Release(); err != nil {
		t.Fatal(err)
	}
}

func TestAcquireExcludesAnotherProcessUntilExit(t *testing.T) {
	directory := t.TempDir()
	command := exec.Command(os.Args[0], "-test.run=^TestOwnershipLockHelperProcess$")
	command.Env = append(os.Environ(),
		"CONVENEWIRE_OWNERSHIP_HELPER=1",
		"CONVENEWIRE_OWNERSHIP_DIRECTORY="+directory,
	)
	stdin, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = stdin.Close()
		_ = command.Process.Kill()
		_ = command.Wait()
	}()
	scanner := bufio.NewScanner(stdout)
	if !scanner.Scan() || scanner.Text() != "locked" {
		t.Fatalf("lock helper did not acquire the directory: %q", scanner.Text())
	}
	if second, err := Acquire(directory); err == nil {
		_ = second.Release()
		t.Fatal("another process owned the same Bridge data directory")
	}
	if err := stdin.Close(); err != nil {
		t.Fatal(err)
	}
	if err := command.Wait(); err != nil {
		t.Fatal(err)
	}
	reacquired, err := Acquire(directory)
	if err != nil {
		t.Fatalf("process exit did not release Bridge ownership: %v", err)
	}
	if err := reacquired.Release(); err != nil {
		t.Fatal(err)
	}
}

func TestOwnershipLockHelperProcess(t *testing.T) {
	if os.Getenv("CONVENEWIRE_OWNERSHIP_HELPER") != "1" {
		return
	}
	lock, err := Acquire(os.Getenv("CONVENEWIRE_OWNERSHIP_DIRECTORY"))
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	if _, err := fmt.Fprintln(os.Stdout, "locked"); err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, os.Stdin)
}

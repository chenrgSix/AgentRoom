//go:build darwin || linux

package admission

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"testing"
	"time"

	bridgeruntime "convenewire.dev/bridge/internal/runtime"
)

func TestGovernedProcessStoreFencesLiveInheritedProcessGroupAfterRestart(t *testing.T) {
	store, dataDir, owner := governedProcessStoreFixture(t)
	identity := governedProcessIdentityFixture()
	lease, err := store.PrepareProcess(identity)
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command("/bin/sh", "-c", "sleep 30")
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	command.ExtraFiles = []*os.File{lease.InheritedLockFile()}
	if err := command.Start(); err != nil {
		_ = lease.Abandon()
		t.Fatal(err)
	}
	observation := bridgeruntime.GovernedProcessObservation{PID: command.Process.Pid,
		PlatformIdentity: fmt.Sprintf("process-group:%d", command.Process.Pid)}
	if err := lease.Started(observation); err != nil {
		_ = command.Process.Kill()
		_ = command.Wait()
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		_ = command.Process.Kill()
		_ = command.Wait()
		t.Fatal(err)
	}
	reopened, err := OpenGovernedProcessStore(context.Background(), dataDir, owner)
	if err != nil {
		_ = command.Process.Kill()
		_ = command.Wait()
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := reopened.FenceAll(ctx); err != nil {
		_ = command.Process.Kill()
		_ = command.Wait()
		t.Fatal(err)
	}
	if err := reopened.FenceAndWait(ctx, governedProcessAdmissionView(identity)); err != nil {
		t.Fatalf("exact finished replay failed: %v", err)
	}
	if err := command.Wait(); err == nil {
		t.Fatal("fenced Runtime process exited successfully")
	}
	view, err := reopened.get(identity.RunID)
	if err != nil || view.terminalStage != governedProcessFinished || view.active == nil ||
		view.active.Observation != observation {
		t.Fatalf("view=%+v err=%v", view, err)
	}
}

func TestGovernedProcessLeaseFinishesOnlyAfterObservedProcessExit(t *testing.T) {
	store, _, _ := governedProcessStoreFixture(t)
	identity := governedProcessIdentityFixture()
	lease, err := store.PrepareProcess(identity)
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command("/bin/sh", "-c", "exit 0")
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	command.ExtraFiles = []*os.File{lease.InheritedLockFile()}
	if err := command.Start(); err != nil {
		_ = lease.Abandon()
		t.Fatal(err)
	}
	observation := bridgeruntime.GovernedProcessObservation{PID: command.Process.Pid,
		PlatformIdentity: fmt.Sprintf("process-group:%d", command.Process.Pid)}
	if err := lease.Started(observation); err != nil {
		_ = command.Process.Kill()
		_ = command.Wait()
		t.Fatal(err)
	}
	if err := command.Wait(); err != nil {
		t.Fatal(err)
	}
	if err := lease.Finished(observation); err != nil {
		t.Fatal(err)
	}
	view, err := store.get(identity.RunID)
	if err != nil || view.terminalStage != governedProcessFinished {
		t.Fatalf("view=%+v err=%v", view, err)
	}
	if err := lease.Finished(observation); !errors.Is(err, ErrAdmissionChanged) {
		t.Fatalf("closed lease replay error=%v", err)
	}
}

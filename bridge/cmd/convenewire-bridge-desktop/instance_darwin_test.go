//go:build desktop && darwin

package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func darwinTestRoot(t *testing.T) string {
	t.Helper()
	// The Darwin sun_path limit includes the full name. Go's default test
	// directory may exceed it before the application-specific suffix is added.
	root, err := os.MkdirTemp(os.TempDir(), "cwipc-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(root); err != nil {
			t.Error("remove isolated activation fixture", err)
		}
	})
	return root
}

func darwinTestOptions(root string) darwinInstanceOptions {
	return darwinInstanceOptions{
		TempDir: root, InstanceID: "convenewire-mac-ipc-test", ExpectedUID: uint32(os.Geteuid()),
		StartupTimeout: 3 * time.Second, IOTimeout: 250 * time.Millisecond,
		CaptureTimeout: 100 * time.Millisecond, MaxConnections: 4,
		CaptureURL: func(time.Duration) (string, error) { return "", nil },
	}
}

func darwinTestPaths(t *testing.T, options darwinInstanceOptions) darwinActivationPaths {
	t.Helper()
	paths, err := prepareDarwinPaths(options.TempDir, options.InstanceID, options.ExpectedUID)
	if err != nil {
		t.Fatal(err)
	}
	return paths
}

func darwinOtherPairingLink() string {
	return strings.Replace(testActivationLink(), "pairing_12345678", "pairing_87654321", 1)
}

type darwinTestProcess struct {
	command *exec.Cmd
	input   io.WriteCloser
	lines   chan string
	done    chan struct{}
	err     error
	stderr  bytes.Buffer
}

func startDarwinTestProcess(t *testing.T, root, mode string) *darwinTestProcess {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	process := &darwinTestProcess{lines: make(chan string, 32), done: make(chan struct{})}
	process.command = exec.CommandContext(ctx, os.Args[0], "-test.run=^TestDarwinActivationHelperProcess$")
	process.command.Env = append(os.Environ(), "CONVENE_WIRE_DARWIN_IPC_HELPER="+mode,
		"CONVENE_WIRE_DARWIN_IPC_ROOT="+root)
	process.command.Stderr = &process.stderr
	output, err := process.command.StdoutPipe()
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	process.input, err = process.command.StdinPipe()
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	if err := process.command.Start(); err != nil {
		cancel()
		t.Fatal(err)
	}
	var readDone sync.WaitGroup
	readDone.Add(1)
	go func() {
		defer readDone.Done()
		defer close(process.lines)
		scanner := bufio.NewScanner(output)
		for scanner.Scan() {
			process.lines <- scanner.Text()
		}
	}()
	go func() {
		// Read through EOF before Wait closes the pipe, retaining all status lines.
		readDone.Wait()
		process.err = process.command.Wait()
		close(process.done)
	}()
	t.Cleanup(func() {
		_ = process.input.Close()
		cancel()
		<-process.done
		if strings.Contains(process.stderr.String(), "claimSecret") ||
			strings.Contains(process.stderr.String(), strings.Repeat("s", 43)) {
			t.Error("native helper diagnostic leaked pairing proof")
		}
	})
	return process
}

func (process *darwinTestProcess) await(t *testing.T, expected string) {
	t.Helper()
	select {
	case line, ok := <-process.lines:
		if !ok || line != expected {
			t.Fatalf("native fixture status %q, want %q", line, expected)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("native fixture status deadline exceeded")
	}
}

func (process *darwinTestProcess) send(t *testing.T, command string) {
	t.Helper()
	if _, err := fmt.Fprintln(process.input, command); err != nil {
		t.Fatal("send fixture control command", err)
	}
}

func (process *darwinTestProcess) wait(t *testing.T) {
	t.Helper()
	select {
	case <-process.done:
		if process.err != nil {
			t.Fatal("native fixture failed", process.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("native fixture exit deadline exceeded")
	}
}

func TestDarwinNativeSecondaryWaitsForListenerAndUIWithoutAnotherConsole(t *testing.T) {
	root := darwinTestRoot(t)
	options := darwinTestOptions(root)
	paths := darwinTestPaths(t, options)
	owner := startDarwinTestProcess(t, root, "owner")
	owner.await(t, "lease ready")
	secondary := startDarwinTestProcess(t, root, "secondary")
	secondary.await(t, "forwarding")
	select {
	case <-secondary.done:
		t.Fatal("secondary did not wait for its primary listener")
	case <-time.After(75 * time.Millisecond):
	}
	owner.send(t, "listen")
	owner.await(t, "listener ready")
	secondary.await(t, "forwarded")
	secondary.wait(t)
	// The existing process owns real, isolated Console state. Forwarding did
	// not invoke the secondary's primary closure or acquire a second owner.
	if other, err := activationTestConsole(filepath.Join(root, "console")); err == nil {
		other.Close()
		t.Fatal("primary fixture did not retain exclusive Console state")
	}
	for _, link := range []string{testActivationLink(), ""} {
		if err := forwardDarwinActivation(link, paths, options); err != nil {
			t.Fatal("pending duplicate or wake was not acknowledged", err)
		}
	}
	if err := forwardDarwinActivation(darwinOtherPairingLink(), paths, options); err == nil {
		t.Fatal("distinct pairing silently replaced an acknowledged pending intent")
	}
	owner.send(t, "ready")
	owner.await(t, "paired")
	owner.await(t, "ui ready")
	if err := forwardDarwinActivation("", paths, options); err != nil {
		t.Fatal(err)
	}
	owner.await(t, "wake")
	owner.send(t, "stop")
	owner.await(t, "closed")
	owner.wait(t)
	assertDarwinFixtureHasNoProof(t, root)
}

func TestDarwinInitialPairingIsReservedBeforeSecondaryActivation(t *testing.T) {
	root := darwinTestRoot(t)
	options := darwinTestOptions(root)
	paths := darwinTestPaths(t, options)
	initial := testActivationLink()
	activation, err := newDesktopActivation(initial)
	if err != nil {
		t.Fatal("valid initial pairing could not seed UI intent", err)
	}
	instance, err := acquireDarwinInstance(initial, activation, options)
	if err != nil || instance == nil || instance.forwarded {
		t.Fatal("initial pairing process could not become primary", err)
	}
	defer instance.release()
	// Probe B before delivering any duplicate A: otherwise the duplicate would
	// seed an empty queue itself and conceal a missing initial-launch reservation.
	if err := forwardDarwinActivation(darwinOtherPairingLink(), paths, options); err == nil {
		t.Fatal("secondary pairing was acknowledged before initial launch A was reserved")
	}
	// A real second process delivers the same A through the acknowledged
	// socket while the primary's UI has not started. It must only coalesce.
	secondary := startDarwinTestProcess(t, root, "secondary")
	secondary.await(t, "forwarding")
	secondary.await(t, "forwarded")
	secondary.wait(t)
	if err := forwardDarwinActivation("", paths, options); err != nil {
		t.Fatal("wake could not coalesce with reserved initial pairing", err)
	}
	if err := forwardDarwinActivation(darwinOtherPairingLink(), paths, options); err == nil {
		t.Fatal("secondary pairing replaced the initial launch before UI readiness")
	}
	delivered := make(chan string, 4)
	activation.ready(func(fn func()) { fn() }, func(link string) { delivered <- link })
	select {
	case link := <-delivered:
		if link != initial {
			t.Fatal("UI did not receive the reserved initial pairing")
		}
	case <-time.After(time.Second):
		t.Fatal("initial pairing was not dispatched when UI became ready")
	}
	select {
	case <-delivered:
		t.Fatal("duplicate or wake generated a second initial UI delivery")
	default:
	}
	if err := forwardDarwinActivation(darwinOtherPairingLink(), paths, options); err != nil {
		t.Fatal("new pairing remained blocked after initial dispatch", err)
	}
	select {
	case link := <-delivered:
		if link != darwinOtherPairingLink() {
			t.Fatal("later pairing was not delivered after initial dispatch")
		}
	case <-time.After(time.Second):
		t.Fatal("acknowledged later pairing did not reach ready UI")
	}
	select {
	case <-delivered:
		t.Fatal("later pairing was delivered more than once")
	default:
	}
	assertDarwinFixtureHasNoProof(t, root)
}

func TestDarwinNativeCrashReclaimsOnlyStaleSocketAndKeepsLeaseInode(t *testing.T) {
	root := darwinTestRoot(t)
	options := darwinTestOptions(root)
	paths := darwinTestPaths(t, options)
	owner := startDarwinTestProcess(t, root, "owner")
	owner.await(t, "lease ready")
	owner.send(t, "listen")
	owner.await(t, "listener ready")
	leaseBefore, err := os.Stat(paths.lock)
	if err != nil {
		t.Fatal(err)
	}
	owner.send(t, "crash")
	owner.wait(t)
	if socket, err := os.Lstat(paths.socket); err != nil || socket.Mode()&os.ModeSocket == 0 {
		t.Fatal("abrupt fixture exit did not leave the expected stale socket")
	}
	activation := &desktopActivation{}
	instance, err := acquireDarwinInstance("", activation, options)
	if err != nil || instance == nil || instance.forwarded {
		t.Fatal("new primary did not reclaim the crashed owner", err)
	}
	defer instance.release()
	if err := forwardDarwinActivation(testActivationLink(), paths, options); err != nil {
		t.Fatal("recovered receiver did not accept activation", err)
	}
	instance.release()
	if _, err := os.Lstat(paths.socket); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("receiver shutdown left its socket behind")
	}
	leaseAfter, err := os.Stat(paths.lock)
	if err != nil || !os.SameFile(leaseBefore, leaseAfter) {
		t.Fatal("stable lease inode was unlinked or replaced")
	}
	other, err := activationTestConsole(filepath.Join(root, "console"))
	if err != nil {
		t.Fatal("crashed fixture retained Console ownership", err)
	}
	other.Close()
	assertDarwinFixtureHasNoProof(t, root)
}

func TestDarwinLostAcknowledgementIsUncertainWithoutResend(t *testing.T) {
	root := darwinTestRoot(t)
	options := darwinTestOptions(root)
	options.IOTimeout = 100 * time.Millisecond
	paths := darwinTestPaths(t, options)
	listener := darwinTestListener(t, paths.socket)
	var activation desktopActivation
	accepted := make(chan error, 1)
	go func() {
		connection, err := listener.AcceptUnix()
		if err != nil {
			accepted <- err
			return
		}
		defer connection.Close()
		_ = connection.SetDeadline(time.Now().Add(time.Second))
		link, err := readDarwinTestFrame(connection)
		if err == nil && (link != testActivationLink() || !activation.accept(link)) {
			err = errors.New("fixture did not accept expected intent")
		}
		accepted <- err
		// Simulate delivery having happened but its acknowledgement being lost.
	}()
	started := time.Now()
	err := forwardDarwinActivation(testActivationLink(), paths, options)
	if err == nil || !strings.Contains(err.Error(), "uncertain") {
		t.Fatal("lost ACK was reported as success or safe-to-retry")
	}
	if time.Since(started) > time.Second {
		t.Fatal("lost ACK exceeded its bounded delivery wait")
	}
	if err := <-accepted; err != nil {
		t.Fatal(err)
	}
	_ = listener.SetDeadline(time.Now().Add(100 * time.Millisecond))
	if again, err := listener.AcceptUnix(); err == nil {
		again.Close()
		t.Fatal("ambiguous delivery was automatically retried")
	}
	deliveries := 0
	activation.ready(func(fn func()) { fn() }, func(link string) {
		if link != testActivationLink() {
			t.Error("accepted pairing intent changed after lost ACK")
		}
		deliveries++
	})
	if deliveries != 1 {
		t.Fatalf("got %d deliveries after lost ACK, want one", deliveries)
	}
	activation.close()
	assertDarwinErrorHasNoProofOrPath(t, err, root)
}

func TestDarwinShutdownClosesSlowClientsBeforeReleasingLease(t *testing.T) {
	root := darwinTestRoot(t)
	options := darwinTestOptions(root)
	options.IOTimeout = 5 * time.Second // Shutdown must not wait for this timeout.
	paths := darwinTestPaths(t, options)
	activation := &desktopActivation{}
	instance, err := acquireDarwinInstance("", activation, options)
	if err != nil {
		t.Fatal(err)
	}
	defer instance.release()
	var clients []*net.UnixConn
	for index := 0; index < options.MaxConnections+2; index++ {
		connection, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: paths.socket, Net: "unix"})
		if err != nil {
			t.Fatal(err)
		}
		clients = append(clients, connection)
		defer connection.Close()
		_, _ = connection.Write([]byte{0}) // A deliberately incomplete header.
	}
	closed := make(chan struct{})
	go func() { instance.release(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("receiver shutdown waited for slow client I/O")
	}
	if activation.accept(testActivationLink()) {
		t.Fatal("shutdown receiver still accepted new pairing intent")
	}
	for _, connection := range clients {
		_ = connection.SetReadDeadline(time.Now().Add(250 * time.Millisecond))
		var acknowledgement [1]byte
		_, err := connection.Read(acknowledgement[:])
		if networkErr, ok := err.(net.Error); err == nil || (ok && networkErr.Timeout()) {
			t.Fatal("shutdown did not close an outstanding client")
		}
	}
	lease, primary, err := acquireDarwinFileLease(paths.lock, options.ExpectedUID)
	if err != nil || !primary {
		t.Fatal("shutdown retained the desktop lease", err)
	}
	lease.Close()
}

func TestDarwinMalformedAndIncompleteFramesCannotBecomeWake(t *testing.T) {
	root := darwinTestRoot(t)
	options := darwinTestOptions(root)
	options.IOTimeout = 100 * time.Millisecond
	paths := darwinTestPaths(t, options)
	var activation desktopActivation
	instance, err := acquireDarwinInstance("", &activation, options)
	if err != nil {
		t.Fatal(err)
	}
	defer instance.release()
	frame := func(size uint32, payload []byte) []byte {
		result := make([]byte, 4+len(payload))
		binary.BigEndian.PutUint32(result, size)
		copy(result[4:], payload)
		return result
	}
	for name, input := range map[string][]byte{
		"zero": frame(0, nil), "oversize": frame(maxActivationEncodedBytes+1, nil),
		"short header": {0, 0}, "short payload": frame(50, []byte("x")),
		"invalid encoded": frame(3, []byte("bad")),
	} {
		t.Run(name, func(t *testing.T) {
			connection, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: paths.socket, Net: "unix"})
			if err != nil {
				t.Fatal(err)
			}
			defer connection.Close()
			_ = connection.SetDeadline(time.Now().Add(time.Second))
			_, _ = connection.Write(input)
			var ack [1]byte
			n, err := connection.Read(ack[:])
			if n > 0 && ack[0] == 1 {
				t.Fatal("malformed activation was acknowledged")
			}
			if networkErr, ok := err.(net.Error); ok && networkErr.Timeout() {
				t.Fatal("malformed client was not bounded by the server timeout")
			}
		})
	}
	activation.ready(func(fn func()) { fn() }, func(string) { t.Error("malformed input reached UI intent delivery") })
}

func TestDarwinRendezvousRejectsUnsafePathsAndForeignOwnership(t *testing.T) {
	for _, kind := range []string{"root symlink", "root permissions", "foreign uid", "private symlink", "private permissions", "overlong"} {
		t.Run(kind, func(t *testing.T) {
			root := darwinTestRoot(t)
			options := darwinTestOptions(root)
			paths := darwinTestPaths(t, options)
			switch kind {
			case "root symlink":
				linked := root + "-link"
				if err := os.Symlink(root, linked); err != nil {
					t.Fatal(err)
				}
				defer os.Remove(linked)
				options.TempDir = linked
			case "root permissions":
				if err := os.Chmod(root, 0o770); err != nil {
					t.Fatal(err)
				}
			case "foreign uid":
				options.ExpectedUID++ // A mismatch check, not a second OS-user execution.
			case "private symlink":
				if err := os.Remove(paths.directory); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(root, paths.directory); err != nil {
					t.Fatal(err)
				}
			case "private permissions":
				if err := os.Chmod(paths.directory, 0o750); err != nil {
					t.Fatal(err)
				}
			case "overlong":
				options.TempDir = filepath.Join(root, strings.Repeat("d", 85))
				if err := os.Mkdir(options.TempDir, 0o700); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := prepareDarwinPaths(options.TempDir, options.InstanceID, options.ExpectedUID); err == nil {
				t.Fatal("unsafe rendezvous path accepted")
			} else {
				assertDarwinErrorHasNoProofOrPath(t, err, root)
			}
		})
	}
}

func TestDarwinLeaseRejectsSymlinksHardlinksModesAndForeignUID(t *testing.T) {
	for _, kind := range []string{"symlink", "hardlink", "permissions", "directory", "foreign uid"} {
		t.Run(kind, func(t *testing.T) {
			root := darwinTestRoot(t)
			options := darwinTestOptions(root)
			paths := darwinTestPaths(t, options)
			sentinel := filepath.Join(root, "sentinel")
			content := []byte("unrelated fixture data")
			if err := os.WriteFile(sentinel, content, 0o600); err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "symlink":
				if err := os.Symlink(sentinel, paths.lock); err != nil {
					t.Fatal(err)
				}
			case "hardlink":
				if err := os.Link(sentinel, paths.lock); err != nil {
					t.Fatal(err)
				}
			case "permissions":
				if err := os.WriteFile(paths.lock, nil, 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.Chmod(paths.lock, 0o640); err != nil {
					t.Fatal(err)
				}
			case "directory":
				if err := os.Mkdir(paths.lock, 0o700); err != nil {
					t.Fatal(err)
				}
			case "foreign uid":
				options.ExpectedUID++
			}
			lease, primary, err := acquireDarwinFileLease(paths.lock, options.ExpectedUID)
			if lease != nil {
				lease.Close()
			}
			if err == nil || primary {
				t.Fatal("unsafe lease was acquired or mistaken for an existing primary")
			}
			got, readErr := os.ReadFile(sentinel)
			if readErr != nil || !bytes.Equal(got, content) {
				t.Fatal("lease validation changed an unrelated target")
			}
		})
	}
}

func TestDarwinLegacyOwnerFailsExplicitlyWithoutBypassingItsLock(t *testing.T) {
	root := darwinTestRoot(t)
	options := darwinTestOptions(root)
	paths := darwinTestPaths(t, options)
	legacy, acquired, err := acquireDarwinFileLease(paths.legacyLock, options.ExpectedUID)
	if err != nil || !acquired {
		t.Fatal("acquire isolated legacy lease", err)
	}
	defer legacy.Close()
	if instance, err := acquireDarwinInstance(testActivationLink(), &desktopActivation{}, options); err == nil || instance != nil {
		if instance != nil && instance.release != nil {
			instance.release()
		}
		t.Fatal("new executable bypassed the legacy owner")
	} else if !strings.Contains(err.Error(), "older") {
		t.Fatal("legacy ownership did not produce an actionable generic error")
	}
	modern, primary, err := acquireDarwinFileLease(paths.lock, options.ExpectedUID)
	if err != nil || !primary {
		t.Fatal("legacy failure leaked the modern lease", err)
	}
	modern.Close()
	if _, err := os.Lstat(paths.socket); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("legacy failure created an activation receiver")
	}
}

func TestDarwinEndpointValidationRejectsSymlinkAndPreservesRegularFiles(t *testing.T) {
	for _, kind := range []string{"symlink", "regular", "public socket"} {
		t.Run(kind, func(t *testing.T) {
			root := darwinTestRoot(t)
			options := darwinTestOptions(root)
			paths := darwinTestPaths(t, options)
			target := filepath.Join(root, "peer.sock")
			listener := darwinTestListener(t, target)
			switch kind {
			case "symlink":
				if err := os.Symlink(target, paths.socket); err != nil {
					t.Fatal(err)
				}
			case "regular":
				if err := os.WriteFile(paths.socket, []byte("keep this file"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "public socket":
				listener.Close()
				listener = darwinTestListener(t, paths.socket)
				options.StartupTimeout = 100 * time.Millisecond
				if err := os.Chmod(paths.socket, 0o666); err != nil {
					t.Fatal(err)
				}
			}
			if err := forwardDarwinActivation(testActivationLink(), paths, options); err == nil {
				t.Fatal("sender used an unsafe activation endpoint")
			} else {
				assertDarwinErrorHasNoProofOrPath(t, err, root)
			}
			_ = listener.SetDeadline(time.Now().Add(75 * time.Millisecond))
			if connection, err := listener.AcceptUnix(); err == nil {
				connection.Close()
				t.Fatal("rejected endpoint still received a connection or pairing proof")
			}
			if kind != "public socket" {
				if instance, err := acquireDarwinInstance("", &desktopActivation{}, options); err == nil {
					instance.release()
					t.Fatal("primary removed an unsafe endpoint as a stale socket")
				}
				if info, err := os.Lstat(paths.socket); err != nil || (kind == "symlink" && info.Mode()&os.ModeSymlink == 0) {
					t.Fatal("unsafe endpoint was removed or replaced")
				}
				if kind == "regular" {
					if content, err := os.ReadFile(paths.socket); err != nil || string(content) != "keep this file" {
						t.Fatal("regular endpoint was changed")
					}
				}
			}
		})
	}
}

func TestDarwinSenderWaitsForPrivateSocketBeforeSendingProof(t *testing.T) {
	root := darwinTestRoot(t)
	options := darwinTestOptions(root)
	paths := darwinTestPaths(t, options)
	listener := darwinTestListener(t, paths.socket)
	if err := os.Chmod(paths.socket, 0o755); err != nil {
		t.Fatal(err)
	}
	forwarded := make(chan error, 1)
	go func() { forwarded <- forwardDarwinActivation(testActivationLink(), paths, options) }()
	// A listener may be bound before its chmod completes. Until it is private,
	// no connection or proof may reach it, but this startup race can recover.
	_ = listener.SetDeadline(time.Now().Add(75 * time.Millisecond))
	if premature, err := listener.AcceptUnix(); err == nil {
		premature.Close()
		t.Fatal("sender connected before the endpoint became private")
	}
	select {
	case err := <-forwarded:
		t.Fatal("sender did not allow private endpoint setup to complete", err)
	default:
	}
	if err := os.Chmod(paths.socket, 0o600); err != nil {
		t.Fatal(err)
	}
	_ = listener.SetDeadline(time.Now().Add(time.Second))
	connection, err := listener.AcceptUnix()
	if err != nil {
		t.Fatal("sender did not retry connection after endpoint setup", err)
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(time.Second))
	link, err := readDarwinTestFrame(connection)
	if err != nil || link != testActivationLink() {
		t.Fatal("private receiver did not receive expected intent", err)
	}
	if _, err := connection.Write([]byte{1}); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-forwarded:
		if err != nil {
			t.Fatal("private endpoint activation failed", err)
		}
	case <-time.After(time.Second):
		t.Fatal("sender did not finish after acknowledged activation")
	}
}

func TestDarwinReceiverCloseDoesNotUnlinkReplacementEndpoint(t *testing.T) {
	root := darwinTestRoot(t)
	options := darwinTestOptions(root)
	paths := darwinTestPaths(t, options)
	instance, err := acquireDarwinInstance("", &desktopActivation{}, options)
	if err != nil {
		t.Fatal(err)
	}
	defer instance.release()
	if err := os.Rename(paths.socket, filepath.Join(paths.directory, "old.sock")); err != nil {
		t.Fatal(err)
	}
	replacement := []byte("unrelated replacement endpoint")
	if err := os.WriteFile(paths.socket, replacement, 0o600); err != nil {
		t.Fatal(err)
	}
	instance.release()
	if got, err := os.ReadFile(paths.socket); err != nil || !bytes.Equal(got, replacement) {
		t.Fatal("receiver close unlinked an endpoint it did not create")
	}
}

func TestDarwinNativePeerCredentialsVerifyBothEndpoints(t *testing.T) {
	root := darwinTestRoot(t)
	listener := darwinTestListener(t, filepath.Join(root, "peer.sock"))
	client, err := net.DialUnix("unix", nil, listener.Addr().(*net.UnixAddr))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	server, err := listener.AcceptUnix()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	for _, connection := range []*net.UnixConn{client, server} {
		if err := verifyDarwinPeer(connection, uint32(os.Geteuid())); err != nil {
			t.Fatal("native same-user peer rejected", err)
		}
		if err := verifyDarwinPeer(connection, uint32(os.Geteuid())+1); err == nil {
			t.Fatal("foreign expected identity was accepted")
		}
	}
	// This validates a real kernel credential mismatch, not a second OS account.
}

func TestDarwinReceiverRejectsForeignExpectedPeerBeforeIntentDelivery(t *testing.T) {
	root := darwinTestRoot(t)
	options := darwinTestOptions(root)
	paths := darwinTestPaths(t, options)
	lease, primary, err := acquireDarwinFileLease(paths.lock, options.ExpectedUID)
	if err != nil || !primary {
		t.Fatal(err)
	}
	defer lease.Close()
	var activation desktopActivation
	foreign := options
	foreign.ExpectedUID++
	server, err := serveDarwinActivation(paths, &activation, foreign)
	if err != nil {
		t.Fatal(err)
	}
	defer server.close()
	if err := forwardDarwinActivation(testActivationLink(), paths, options); err == nil {
		t.Fatal("receiver acknowledged a foreign expected peer")
	}
	activation.ready(func(fn func()) { fn() }, func(string) { t.Error("rejected peer reached intent delivery") })
}

func darwinTestListener(t *testing.T, path string) *net.UnixListener {
	t.Helper()
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	return listener
}

func readDarwinTestFrame(connection *net.UnixConn) (string, error) {
	var header [4]byte
	if _, err := io.ReadFull(connection, header[:]); err != nil {
		return "", err
	}
	size := binary.BigEndian.Uint32(header[:])
	if size == 0 || size > maxActivationEncodedBytes {
		return "", errors.New("invalid fixture frame length")
	}
	encoded := make([]byte, int(size))
	if _, err := io.ReadFull(connection, encoded); err != nil {
		return "", err
	}
	return decodeActivation(string(encoded))
}

func assertDarwinErrorHasNoProofOrPath(t *testing.T, err error, root string) {
	t.Helper()
	if err != nil && (strings.Contains(err.Error(), "claimSecret") ||
		strings.Contains(err.Error(), strings.Repeat("s", 43)) || strings.Contains(err.Error(), root)) {
		t.Fatal("activation diagnostic exposed pairing proof or a local path")
	}
}

func assertDarwinFixtureHasNoProof(t *testing.T, root string) {
	t.Helper()
	if err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if bytes.Contains(content, []byte("claimSecret")) || bytes.Contains(content, []byte(strings.Repeat("s", 43))) {
			return errors.New("fixture persisted pairing proof")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestDarwinActivationHelperProcess(t *testing.T) {
	mode := os.Getenv("CONVENE_WIRE_DARWIN_IPC_HELPER")
	if mode == "" {
		t.Skip("subprocess-only native IPC fixture")
	}
	root := os.Getenv("CONVENE_WIRE_DARWIN_IPC_ROOT")
	options := darwinTestOptions(root)
	if mode == "secondary" {
		fmt.Println("forwarding")
		err := runWithDesktopInstance(func() (*desktopInstance, error) {
			return acquireDarwinInstance(testActivationLink(), &desktopActivation{}, options)
		}, func(*desktopInstance) error { return errors.New("secondary attempted to construct another Console") })
		if err != nil {
			t.Fatal("secondary failed", err)
		}
		fmt.Println("forwarded")
		return
	}
	if mode != "owner" {
		t.Fatal("unknown fixture mode")
	}
	paths := darwinTestPaths(t, options)
	lease, primary, err := acquireDarwinFileLease(paths.lock, options.ExpectedUID)
	if err != nil || !primary {
		t.Fatal("fixture failed to acquire modern lease", err)
	}
	defer lease.Close()
	legacy, primary, err := acquireDarwinFileLease(paths.legacyLock, options.ExpectedUID)
	if err != nil || !primary {
		t.Fatal("fixture failed to acquire legacy guard", err)
	}
	defer legacy.Close()
	fmt.Println("lease ready")
	scanner := bufio.NewScanner(os.Stdin)
	if !scanner.Scan() || scanner.Text() != "listen" {
		t.Fatal("missing listener startup gate")
	}
	var activation desktopActivation
	server, err := serveDarwinActivation(paths, &activation, options)
	if err != nil {
		t.Fatal("fixture listener failed", err)
	}
	defer server.close()
	service, err := activationTestConsole(filepath.Join(root, "console"))
	if err != nil {
		t.Fatal("isolated Console failed", err)
	}
	defer service.Close()
	fmt.Println("listener ready")
	for scanner.Scan() {
		switch scanner.Text() {
		case "ready":
			activation.ready(func(fn func()) { fn() }, func(link string) {
				switch link {
				case testActivationLink():
					fmt.Println("paired")
				case "":
					fmt.Println("wake")
				default:
					fmt.Println("unexpected pairing")
				}
			})
			fmt.Println("ui ready")
		case "stop":
			service.Close()
			server.close()
			legacy.Close()
			lease.Close()
			fmt.Println("closed")
			return
		case "crash":
			os.Exit(0) // Simulate process death: no socket unlink or owner defers.
		default:
			t.Fatal("unexpected fixture control command")
		}
	}
	t.Fatal("fixture owner lost its control channel")
}

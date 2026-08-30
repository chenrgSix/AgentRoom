//go:build desktop && darwin

package main

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

const darwinSocketPathLimit = 104

type darwinInstanceOptions struct {
	TempDir, InstanceID                       string
	ExpectedUID                               uint32
	StartupTimeout, IOTimeout, CaptureTimeout time.Duration
	MaxConnections                            int
	CaptureURL                                func(time.Duration) (string, error)
}

type darwinActivationPaths struct {
	directory, lock, legacyLock, socket string
}

func acquireDesktopInstance(link string, activation *desktopActivation) (*desktopInstance, error) {
	root, err := darwinNativeTempDirectory()
	if err != nil {
		return nil, err
	}
	return acquireDarwinInstance(link, activation, darwinInstanceOptions{
		TempDir: root, InstanceID: desktopInstanceID, ExpectedUID: uint32(os.Geteuid()),
		StartupTimeout: 5 * time.Second, IOTimeout: time.Second, CaptureTimeout: time.Second,
		MaxConnections: 8, CaptureURL: captureDarwinLaunchURL,
	})
}

func acquireDarwinInstance(link string, activation *desktopActivation, options darwinInstanceOptions) (*desktopInstance, error) {
	if activation == nil || options.StartupTimeout <= 0 || options.IOTimeout <= 0 || options.MaxConnections < 1 || options.MaxConnections > 64 {
		return nil, errors.New("invalid macOS desktop activation configuration")
	}
	validated, err := pairingLinkFromLaunch(link, nil)
	if err != nil {
		return nil, errInvalidActivation
	}
	paths, err := prepareDarwinPaths(options.TempDir, options.InstanceID, options.ExpectedUID)
	if err != nil {
		return nil, err
	}
	lease, primary, err := acquireDarwinFileLease(paths.lock, options.ExpectedUID)
	if err != nil {
		return nil, err
	}
	if !primary {
		// LaunchServices delivers URLs through AppleEvents rather than argv.
		// Only a secondary runs this short native loop; a primary keeps Wails'
		// normal URL handler and never initializes Cocoa twice.
		if validated == "" && options.CaptureURL != nil {
			validated, err = options.CaptureURL(options.CaptureTimeout)
			if err != nil {
				return nil, errors.New("could not capture macOS desktop activation")
			}
			if validated, err = pairingLinkFromLaunch(validated, nil); err != nil {
				return nil, errInvalidActivation
			}
		}
		if err := forwardDarwinActivation(validated, paths, options); err != nil {
			return nil, err
		}
		return &desktopInstance{forwarded: true}, nil
	}
	// The modern inode is stable and never unlinked. The released Wails lock is
	// only a mixed-version guard: old versions unlink it after unlocking, so it
	// cannot be our sole lease or imply retroactive reliable legacy forwarding.
	legacy, acquired, err := acquireDarwinFileLease(paths.legacyLock, options.ExpectedUID)
	if err != nil || !acquired {
		_ = lease.Close()
		if err != nil {
			return nil, err
		}
		return nil, errors.New("an older desktop instance is running; close it before opening this version")
	}
	server, err := serveDarwinActivation(paths, activation, options)
	if err != nil {
		_ = legacy.Close()
		_ = lease.Close()
		return nil, err
	}
	var once sync.Once
	return &desktopInstance{release: func() {
		once.Do(func() {
			server.close()
			_ = legacy.Close()
			_ = lease.Close()
		})
	}}, nil // Wails SingleInstance deliberately remains nil on Darwin.
}

func prepareDarwinPaths(root, id string, uid uint32) (darwinActivationPaths, error) {
	var paths darwinActivationPaths
	if !filepath.IsAbs(root) || id == "" || len(id) > 128 || strings.ContainsAny(id, "/\\\x00") {
		return paths, errors.New("invalid macOS desktop rendezvous identity")
	}
	root = filepath.Clean(root)
	if err := validateDarwinDirectory(root, uid); err != nil {
		return paths, err
	}
	digest := sha256.Sum256([]byte(id))
	paths.directory = filepath.Join(root, "cw-"+hex.EncodeToString(digest[:8]))
	paths.lock = filepath.Join(paths.directory, "lease")
	paths.socket = filepath.Join(paths.directory, "a.sock")
	paths.legacyLock = filepath.Join(root, id+".lock")
	if len(paths.socket) >= darwinSocketPathLimit {
		return darwinActivationPaths{}, errors.New("macOS desktop activation socket path exceeds its platform limit")
	}
	if err := os.Mkdir(paths.directory, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return darwinActivationPaths{}, errors.New("create private macOS desktop activation directory")
	}
	if err := validateDarwinDirectory(paths.directory, uid); err != nil {
		return darwinActivationPaths{}, err
	}
	return paths, nil
}

func validateDarwinDirectory(path string, uid uint32) error {
	var stat unix.Stat_t
	if unix.Lstat(path, &stat) != nil || stat.Mode&unix.S_IFMT != unix.S_IFDIR || stat.Mode&0o077 != 0 {
		return errors.New("macOS desktop activation directory must be private and owned by the current user")
	}
	if stat.Uid != uid {
		return errors.New("macOS desktop activation directory belongs to a different user")
	}
	return nil
}

func acquireDarwinFileLease(path string, uid uint32) (*os.File, bool, error) {
	fd, err := unix.Open(path, unix.O_RDWR|unix.O_CREAT|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0o600)
	if err != nil {
		return nil, false, errors.New("open macOS desktop instance lease")
	}
	file := os.NewFile(uintptr(fd), path)
	var stat, pathStat unix.Stat_t
	if unix.Fstat(fd, &stat) != nil || unix.Lstat(path, &pathStat) != nil ||
		stat.Mode&unix.S_IFMT != unix.S_IFREG || stat.Uid != uid || stat.Mode&0o777 != 0o600 ||
		stat.Nlink != 1 || stat.Dev != pathStat.Dev || stat.Ino != pathStat.Ino {
		_ = file.Close()
		return nil, false, errors.New("macOS desktop instance lease must be a private regular file")
	}
	if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		_ = file.Close()
		if errors.Is(err, unix.EWOULDBLOCK) || errors.Is(err, unix.EAGAIN) {
			return nil, false, nil
		}
		return nil, false, errors.New("acquire macOS desktop instance lease")
	}
	if unix.Lstat(path, &pathStat) != nil || stat.Dev != pathStat.Dev || stat.Ino != pathStat.Ino {
		_ = file.Close()
		return nil, false, errors.New("macOS desktop instance lease changed during acquisition")
	}
	return file, true, nil
}

func verifyDarwinPeer(connection *net.UnixConn, uid uint32) error {
	raw, err := connection.SyscallConn()
	if err != nil {
		return errors.New("inspect macOS desktop activation peer")
	}
	verified := false
	if err := raw.Control(func(fd uintptr) {
		credentials, err := unix.GetsockoptXucred(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERCRED)
		verified = err == nil && credentials.Version == 0 && credentials.Uid == uid
	}); err != nil || !verified {
		return errors.New("macOS desktop activation peer is not the current user")
	}
	return nil
}

type darwinActivationServer struct {
	listener    *net.UnixListener
	paths       darwinActivationPaths
	socketInfo  os.FileInfo
	activation  *desktopActivation
	options     darwinInstanceOptions
	mu          sync.Mutex
	closed      bool
	connections map[*net.UnixConn]struct{}
	wait        sync.WaitGroup
	once        sync.Once
}

// Caller must hold the modern lease throughout serving and close. Never remove
// a regular file or symlink as a stale socket, even in our private directory.
func serveDarwinActivation(paths darwinActivationPaths, activation *desktopActivation, options darwinInstanceOptions) (*darwinActivationServer, error) {
	if info, err := os.Lstat(paths.socket); err == nil {
		var stat unix.Stat_t
		if info.Mode()&os.ModeSocket == 0 || unix.Lstat(paths.socket, &stat) != nil || stat.Uid != options.ExpectedUID {
			return nil, errors.New("macOS desktop activation endpoint is not an owned socket")
		}
		if err := os.Remove(paths.socket); err != nil {
			return nil, errors.New("remove stale macOS desktop activation socket")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, errors.New("inspect macOS desktop activation endpoint")
	}
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: paths.socket, Net: "unix"})
	if err != nil {
		return nil, errors.New("listen for macOS desktop activation")
	}
	listener.SetUnlinkOnClose(false)
	info, err := os.Lstat(paths.socket)
	if err != nil {
		_ = listener.Close()
		return nil, errors.New("inspect new macOS desktop activation socket")
	}
	if err := os.Chmod(paths.socket, 0o600); err != nil {
		_ = listener.Close()
		if current, statErr := os.Lstat(paths.socket); statErr == nil && os.SameFile(info, current) {
			_ = os.Remove(paths.socket)
		}
		return nil, errors.New("protect macOS desktop activation socket")
	}
	server := &darwinActivationServer{listener: listener, paths: paths, socketInfo: info, activation: activation,
		options: options, connections: make(map[*net.UnixConn]struct{})}
	server.wait.Add(1)
	go server.accept()
	return server, nil
}

func (server *darwinActivationServer) accept() {
	defer server.wait.Done()
	for {
		connection, err := server.listener.AcceptUnix()
		if err != nil {
			return
		}
		server.mu.Lock()
		if server.closed || len(server.connections) >= server.options.MaxConnections {
			server.mu.Unlock()
			_ = connection.Close()
			continue
		}
		server.connections[connection] = struct{}{}
		server.wait.Add(1)
		server.mu.Unlock()
		go server.receive(connection)
	}
}

func (server *darwinActivationServer) receive(connection *net.UnixConn) {
	defer func() {
		_ = connection.Close()
		server.mu.Lock()
		delete(server.connections, connection)
		server.mu.Unlock()
		server.wait.Done()
	}()
	_ = connection.SetDeadline(time.Now().Add(server.options.IOTimeout))
	if verifyDarwinPeer(connection, server.options.ExpectedUID) != nil {
		return
	}
	var header [4]byte
	if _, err := io.ReadFull(connection, header[:]); err != nil {
		return
	}
	size := binary.BigEndian.Uint32(header[:])
	if size == 0 || size > maxActivationEncodedBytes {
		return
	}
	encoded := make([]byte, int(size))
	if _, err := io.ReadFull(connection, encoded); err != nil {
		return
	}
	link, err := decodeActivation(string(encoded))
	ack := byte(0)
	if err == nil {
		server.mu.Lock()
		closed := server.closed
		server.mu.Unlock()
		if !closed && server.activation.accept(link) {
			ack = 1
		}
	}
	_, _ = connection.Write([]byte{ack})
}

func (server *darwinActivationServer) close() {
	server.once.Do(func() {
		server.activation.close()
		server.mu.Lock()
		server.closed = true
		_ = server.listener.Close()
		for connection := range server.connections {
			_ = connection.Close()
		}
		server.mu.Unlock()
		server.wait.Wait()
		if info, err := os.Lstat(server.paths.socket); err == nil && info.Mode()&os.ModeSocket != 0 && os.SameFile(info, server.socketInfo) {
			_ = os.Remove(server.paths.socket)
		}
	})
}

func forwardDarwinActivation(link string, paths darwinActivationPaths, options darwinInstanceOptions) error {
	encoded, err := encodeActivation(link)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), options.StartupTimeout)
	defer cancel()
	var connection *net.UnixConn
	for {
		var socketStat unix.Stat_t
		if err := unix.Lstat(paths.socket, &socketStat); err == nil {
			if socketStat.Mode&unix.S_IFMT != unix.S_IFSOCK || socketStat.Uid != options.ExpectedUID {
				return errors.New("macOS desktop activation endpoint must be an owned socket")
			}
			// ListenUnix publishes its pathname before chmod. An owned socket
			// in our private directory can briefly be not ready, but must never
			// be dialled (or receive a proof) until its permissions are private.
			if socketStat.Mode&0o077 != 0 {
				select {
				case <-ctx.Done():
					return errors.New("macOS desktop activation endpoint did not become private before the timeout")
				case <-time.After(25 * time.Millisecond):
					continue
				}
			}
		} else {
			if !errors.Is(err, unix.ENOENT) {
				return errors.New("inspect macOS desktop activation endpoint")
			}
			// Do not dial after a missing-path observation: a newly published
			// socket could appear before dial but still be awaiting chmod.
			select {
			case <-ctx.Done():
				return errors.New("existing macOS desktop instance is not ready; close an older version before trying again")
			case <-time.After(25 * time.Millisecond):
				continue
			}
		}
		candidate, err := (&net.Dialer{}).DialContext(ctx, "unix", paths.socket)
		if err == nil {
			connection = candidate.(*net.UnixConn)
			break
		}
		if !errors.Is(err, unix.ENOENT) && !errors.Is(err, unix.ECONNREFUSED) {
			return errors.New("could not connect to the existing macOS desktop instance")
		}
		select {
		case <-ctx.Done():
			return errors.New("existing macOS desktop instance is not ready; close an older version before trying again")
		case <-time.After(25 * time.Millisecond):
		}
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(options.IOTimeout))
	if err := verifyDarwinPeer(connection, options.ExpectedUID); err != nil {
		return err
	}
	frame := make([]byte, 4+len(encoded))
	binary.BigEndian.PutUint32(frame[:4], uint32(len(encoded)))
	copy(frame[4:], encoded)
	// From the first attempted write onward, an error is uncertain. Never
	// reconnect, resend, or fall through to starting another Console.
	if written, err := connection.Write(frame); err != nil || written != len(frame) {
		return errors.New("macOS desktop activation delivery is uncertain; no automatic retry was attempted")
	}
	var acknowledgement [1]byte
	if _, err := io.ReadFull(connection, acknowledgement[:]); err != nil {
		return errors.New("macOS desktop activation acknowledgement was not received; delivery is uncertain")
	}
	if acknowledgement[0] != 1 {
		return errors.New("existing macOS desktop instance rejected activation")
	}
	return nil
}

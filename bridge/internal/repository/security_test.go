package repository

import (
	"bufio"
	"bytes"
	"compress/zlib"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestPrepareDoesNotExecuteSourceOrInheritedConfiguration(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX executable trap; native Windows behavior is a separate gate")
	}
	f := gitFixture(t, "sha1", Limits{})
	marker := filepath.Join(f.root, "must-not-exist")
	trap := filepath.Join(f.root, "trap-command")
	if err := os.WriteFile(trap, []byte("#!/bin/sh\nprintf executed > '"+marker+"'\nexit 93\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	hooks := filepath.Join(f.root, "hooks")
	if err := os.Mkdir(hooks, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(hooks, "post-checkout"), []byte("#!/bin/sh\nexec '"+trap+"'\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	f.write(t, ".gitattributes", "src/app.txt filter=trap text eol=crlf ident working-tree-encoding=UTF-16\n")
	// Store this file verbatim without checking out or converting app.txt.
	f.git(t, f.sourcePath, "add", ".gitattributes")
	f.git(t, f.sourcePath, "commit", "-m", "untrusted checkout attributes")
	f.base = f.git(t, f.sourcePath, "rev-parse", "HEAD")
	for _, key := range []string{"core.fsmonitor", "filter.trap.smudge", "filter.trap.clean", "filter.trap.process", "core.sshCommand"} {
		f.git(t, f.sourcePath, "config", key, trap)
	}
	f.git(t, f.sourcePath, "config", "core.hooksPath", hooks)
	f.git(t, f.sourcePath, "config", "filter.trap.required", "true")
	global := filepath.Join(f.root, "global-config")
	if err := os.WriteFile(global, []byte("[core]\n hooksPath = "+hooks+"\n fsmonitor = "+trap+"\n[filter \"trap\"]\n smudge = "+trap+"\n required = true\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GIT_CONFIG_GLOBAL", global)
	t.Setenv("GIT_CONFIG_COUNT", "1")
	t.Setenv("GIT_CONFIG_KEY_0", "core.fsmonitor")
	t.Setenv("GIT_CONFIG_VALUE_0", trap)
	t.Setenv("GIT_TRACE", marker)
	t.Setenv("GIT_DIR", f.state)
	t.Setenv("GIT_INDEX_FILE", marker)
	t.Setenv("GIT_SSH_COMMAND", trap)
	t.Setenv("GIT_ASKPASS", trap)
	prepared := mustPrepare(t, f, request(f.base, "untrusted_config"))
	data, err := os.ReadFile(filepath.Join(prepared.Path, "src/app.txt"))
	if err != nil || string(data) != "base\n" {
		t.Fatal("checkout transformed pinned bytes", err)
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("configuration ran a helper or trace writer", err)
	}
}

func TestPrepareDoesNotTrustAssumeUnchangedOrSkipWorktree(t *testing.T) {
	for _, flag := range []string{"--assume-unchanged", "--skip-worktree"} {
		t.Run(flag, func(t *testing.T) {
			f := gitFixture(t, "sha1", Limits{})
			r := request(f.base, "hidden_modification")
			prepared := mustPrepare(t, f, r)
			f.git(t, prepared.Path, "update-index", flag, "src/app.txt")
			if err := os.WriteFile(filepath.Join(prepared.Path, "src/app.txt"), []byte("hidden changed bytes\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			if f.git(t, prepared.Path, "status", "--porcelain=v1") != "" {
				t.Fatal("fixture must hide the modification from ordinary status")
			}
			if _, err := f.preparer.Prepare(context.Background(), f.source, r); !errors.Is(err, ErrChanged) {
				t.Fatal("trusted Git status instead of actual bytes", err)
			}
		})
	}
}

func TestPreparePreservesSymlinksGitlinksAndExecutableBits(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("native symlink privilege and mode acceptance is separate")
	}
	f := gitFixture(t, "sha1", Limits{})
	outside := filepath.Join(f.root, "outside-secret")
	if err := os.WriteFile(outside, []byte("unchanged"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(f.sourcePath, "external-link")); err != nil {
		t.Fatal(err)
	}
	f.write(t, "run.sh", "#!/bin/sh\nexit 0\n")
	if err := os.Chmod(filepath.Join(f.sourcePath, "run.sh"), 0o700); err != nil {
		t.Fatal(err)
	}
	f.git(t, f.sourcePath, "add", "--all")
	f.git(t, f.sourcePath, "update-index", "--add", "--cacheinfo", "160000,"+f.base+",submodule")
	f.git(t, f.sourcePath, "commit", "-m", "special modes")
	f.base = f.git(t, f.sourcePath, "rev-parse", "HEAD")
	prepared := mustPrepare(t, f, request(f.base, "special_modes"))
	link, err := os.Readlink(filepath.Join(prepared.Path, "external-link"))
	if err != nil || link != outside {
		t.Fatal(link, err)
	}
	info, err := os.Stat(filepath.Join(prepared.Path, "run.sh"))
	if err != nil || info.Mode().Perm()&0o111 == 0 {
		t.Fatal("lost executable bit", err)
	}
	files, err := os.ReadDir(filepath.Join(prepared.Path, "submodule"))
	if err != nil || len(files) != 0 {
		t.Fatal("submodule was populated", err)
	}
	secret, err := os.ReadFile(outside)
	if err != nil || string(secret) != "unchanged" {
		t.Fatal("followed a source symlink", err)
	}
}

func TestSourceReplacementRefsAndRetargetedGitFile(t *testing.T) {
	f := gitFixture(t, "sha1", Limits{})
	f.write(t, "src/app.txt", "replacement\n")
	f.git(t, f.sourcePath, "add", "--all")
	f.git(t, f.sourcePath, "commit", "-m", "replacement")
	replacement := f.git(t, f.sourcePath, "rev-parse", "HEAD")
	f.git(t, f.sourcePath, "replace", f.base, replacement)
	prepared := mustPrepare(t, f, request(f.base, "ignore_replacement"))
	if got := f.git(t, prepared.Path, "show", "HEAD:src/app.txt"); got != "base" {
		t.Fatal("used replacement object", got)
	}
	linked := filepath.Join(f.root, "linked-source")
	f.git(t, f.sourcePath, "worktree", "add", "--detach", linked, f.base)
	source, err := InspectSource(context.Background(), f.executable, linked, []string{f.root}, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(linked, ".git"), []byte("gitdir: "+f.source.GitDirectory+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := f.preparer.Prepare(context.Background(), source, request(f.base, "retargeted_gitfile")); !errors.Is(err, ErrChanged) {
		t.Fatal("Git metadata silently retargeted", err)
	}
}

func TestSourceMissingObjectsNeverFetchAndAlternatesAreRejected(t *testing.T) {
	f := gitFixture(t, "sha1", Limits{})
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var attempts atomic.Int32
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			attempts.Add(1)
			connection.Close()
		}
	}()
	t.Cleanup(func() {
		listener.Close()
		select {
		case <-stopped:
		case <-time.After(time.Second):
			t.Error("fixture listener did not stop")
		}
	})
	object := f.git(t, f.sourcePath, "rev-parse", "HEAD:src/app.txt")
	objectPath := filepath.Join(f.source.GitDirectory, "objects", object[:2], object[2:])
	if err := os.Rename(objectPath, objectPath+"-retained"); err != nil {
		t.Fatal(err)
	}
	f.git(t, f.sourcePath, "config", "remote.origin.promisor", "true")
	f.git(t, f.sourcePath, "config", "remote.origin.url", "https://"+listener.Addr().String()+"/must-not-fetch")
	if _, err := f.preparer.Prepare(context.Background(), f.source, request(f.base, "missing_object")); err == nil {
		t.Fatal("missing object accepted")
	}
	if _, err := os.Stat(objectPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("missing source object was fetched", err)
	}
	listener.Close()
	<-stopped
	if attempts.Load() != 0 {
		t.Fatal("missing object attempted a remote connection")
	}
	info := filepath.Join(f.source.GitDirectory, "objects", "info")
	if err := os.WriteFile(filepath.Join(info, "alternates"), []byte(f.state+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := f.preparer.Prepare(context.Background(), f.source, request(f.base, "outside_alternates")); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
}

func TestRealGitBinaryPatchAndCompressedExpansionLimit(t *testing.T) {
	f := gitFixture(t, "sha1", Limits{})
	original := bytes.Repeat([]byte{0, 1, 2, 3, 4, 5}, 2000)
	f.write(t, "binary.dat", string(original))
	f.git(t, f.sourcePath, "add", "--all")
	f.git(t, f.sourcePath, "commit", "-m", "binary base")
	f.base = f.git(t, f.sourcePath, "rev-parse", "HEAD")
	next := append([]byte(nil), original...)
	copy(next[500:520], []byte("bounded binary change"))
	f.write(t, "binary.dat", string(next))
	data := []byte(f.git(t, f.sourcePath, "diff", "--binary", "--no-ext-diff", "--no-textconv") + "\n")
	if !bytes.Contains(data, []byte("GIT binary patch")) {
		t.Fatal("fixture did not produce binary patch")
	}
	hash := sha256.Sum256(data)
	r := request(f.base, "binary_patch")
	r.Inputs = []PatchInput{{BindingID: "input_binary_exact", SHA256: hex.EncodeToString(hash[:]), Bytes: data}}
	prepared := mustPrepare(t, f, r)
	actual, err := os.ReadFile(filepath.Join(prepared.Path, "binary.dat"))
	if err != nil || !bytes.Equal(actual, next) {
		t.Fatal("wrong binary output", err)
	}
	if _, err := patchExpansionBound(data, 4096); !errors.Is(err, ErrLimit) {
		t.Fatal("delta output bypassed resource limit", err)
	}
	if _, err := patchExpansionBound([]byte("GIT binary patch\nliteral 9999999999999\n\n"), 4096); !errors.Is(err, ErrLimit) {
		t.Fatal("literal expansion bypassed resource limit", err)
	}
}

func encodePatchBytesForTest(data []byte) string {
	var text strings.Builder
	for len(data) > 0 {
		count := min(52, len(data))
		prefix := byte('A' + count - 1)
		if count > 26 {
			prefix = byte('a' + count - 27)
		}
		text.WriteByte(prefix)
		for offset := 0; offset < count; offset += 4 {
			var group [4]byte
			copy(group[:], data[offset:min(offset+4, count)])
			value := uint64(binary.BigEndian.Uint32(group[:]))
			var encoded [5]byte
			for index := 4; index >= 0; index-- {
				encoded[index] = patchAlphabet[value%85]
				value /= 85
			}
			text.Write(encoded[:])
		}
		text.WriteByte('\n')
		data = data[count:]
	}
	return text.String()
}

func TestDeltaOutputHeaderAndMalformedBinaryPreflight(t *testing.T) {
	var delta []byte
	delta = binary.AppendUvarint(delta, 10)
	delta = binary.AppendUvarint(delta, 1<<40)
	var compressed bytes.Buffer
	writer := zlib.NewWriter(&compressed)
	writer.Write(delta)
	writer.Close()
	patch := fmt.Sprintf("GIT binary patch\ndelta %d\n%s\n", len(delta), encodePatchBytesForTest(compressed.Bytes()))
	if _, err := patchExpansionBound([]byte(patch), 4096); !errors.Is(err, ErrLimit) {
		t.Fatal("instruction size mistaken for output size", err)
	}
	for _, patch := range []string{"literal -1\n", "delta junk\n", "literal 1\ninvalid\n\n", "literal 1\nA~~~~~\n\n"} {
		if _, err := patchExpansionBound([]byte(patch), 4096); err == nil {
			t.Fatal("malformed hunk accepted", patch)
		}
	}
}

func TestGitRunnerBoundsOutputAndDeadline(t *testing.T) {
	f := gitFixture(t, "sha1", Limits{})
	if _, err := f.preparer.git.run(context.Background(), f.sourcePath, nil, 1, "cat-file", "blob", f.base+":src/app.txt"); !errors.Is(err, ErrLimit) {
		t.Fatal(err)
	}
	if runtime.GOOS == "windows" {
		return
	}
	script := filepath.Join(f.root, "slow-git-fixture")
	// exec replaces the shell, so timeout cleanup cannot leave a sleep child.
	if err := os.WriteFile(script, []byte("#!/bin/sh\nexec /bin/sleep 5\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	g, err := newGit(script, Limits{CommandTimeout: 20 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	if _, err := g.run(context.Background(), f.root, nil, 1024, "version"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatal("deadline did not terminate owned process")
	}
}

func TestRepositoryOwnerProcessHelper(t *testing.T) {
	root := os.Getenv("CONVENE_REPOSITORY_TEST_ROOT")
	if root == "" {
		return
	}
	executable := os.Getenv("CONVENE_REPOSITORY_TEST_GIT")
	p, err := NewPreparer(root, executable, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	fmt.Println("OWNER_HELD")
	var one [1]byte
	if _, err := os.Stdin.Read(one[:]); err != nil && err != io.EOF {
		t.Fatal(err)
	}
}

func TestRepositoryOwnerLockAcrossProcesses(t *testing.T) {
	f := gitFixture(t, "sha1", Limits{})
	if err := f.preparer.Close(); err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	child := exec.CommandContext(ctx, executable, "-test.run=^TestRepositoryOwnerProcessHelper$")
	child.Env = append(os.Environ(), "CONVENE_REPOSITORY_TEST_ROOT="+f.state, "CONVENE_REPOSITORY_TEST_GIT="+f.executable)
	stdin, err := child.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	child.Stderr = &stderr
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	waited := false
	defer func() {
		stdin.Close()
		if !waited {
			child.Process.Kill()
			child.Wait()
		}
	}()
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil || line != "OWNER_HELD\n" {
		t.Fatalf("child owner barrier %q: %v", line, err)
	}
	if other, err := NewPreparer(f.state, f.executable, Limits{}); err == nil {
		other.Close()
		t.Fatal("cross-process owner not excluded")
	}
	if err := stdin.Close(); err != nil {
		t.Fatal(err)
	}
	err = child.Wait()
	waited = true
	if err != nil {
		t.Fatal("child failed", err, stderr.String())
	}
	f.preparer, err = NewPreparer(f.state, f.executable, Limits{})
	if err != nil {
		t.Fatal("owner not released after process exit", err)
	}
	mustPrepare(t, f, request(f.base, "after_child_exit"))
}

func TestPreparerRejectsForeignRootAndRetargetedState(t *testing.T) {
	f := gitFixture(t, "sha1", Limits{})
	if p, err := NewPreparer(f.sourcePath, f.executable, Limits{}); !errors.Is(err, ErrInvalid) {
		if p != nil {
			p.Close()
		}
		t.Fatal("adopted source checkout as journal", err)
	}
	if _, err := os.Stat(filepath.Join(f.sourcePath, ".bridge-owner.lock")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("foreign root mutated", err)
	}
	claims := filepath.Join(f.state, "claims")
	if err := os.Rename(claims, claims+"-retained"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(claims, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := f.preparer.Prepare(context.Background(), f.source, request(f.base, "retargeted_state")); !errors.Is(err, ErrChanged) {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(claims)
	if err != nil || len(entries) != 0 {
		t.Fatal("wrote into replaced journal", err)
	}
}

func TestImmutableRecordInstallationAndTornRecordRejection(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "operation.json")
	value := map[string]string{"operation": "original"}
	if err := ensureExactJSON(path, value); err != nil {
		t.Fatal(err)
	}
	if err := ensureExactJSON(path, value); err != nil {
		t.Fatal(err)
	}
	if err := ensureExactJSON(path, map[string]string{"operation": "changed"}); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	if err := writeExclusive(path, []byte("replacement")); !errors.Is(err, os.ErrExist) {
		t.Fatal("overwrote immutable record", err)
	}
	if err := os.WriteFile(path, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	var decoded map[string]string
	if err := readJSON(path, &decoded); !errors.Is(err, ErrChanged) {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 1 {
		t.Fatal("temporary journal file leaked", err)
	}
}

func TestFrozenInputsDoNotAliasTransportBuffers(t *testing.T) {
	input := patch("base", "frozen", "frozen_buffer")
	inputs := []PatchInput{input}
	frozen, err := freezeInputs(inputs, 4096)
	if err != nil {
		t.Fatal(err)
	}
	input.Bytes[0] = '!'
	inputs[0].BindingID = "input_replaced_buffer"
	if frozen[0].Bytes[0] == '!' || frozen[0].BindingID != input.BindingID {
		t.Fatal("input buffer was not frozen")
	}
	if _, err := freezeInputs(inputs, 1); !errors.Is(err, ErrLimit) {
		t.Fatal(err)
	}
}

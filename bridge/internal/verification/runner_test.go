package verification

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestVerificationHelperProcess(t *testing.T) {
	if len(os.Args) < 3 || os.Args[1] != "-test.run=TestVerificationHelperProcess" || os.Args[2] != "--" {
		return
	}
	switch os.Args[3] {
	case "pass":
		fmt.Fprintln(os.Stdout, "verification passed in "+os.Args[4])
		fmt.Fprintln(os.Stderr, "diagnostic under "+os.Args[5])
	case "fail":
		fmt.Fprintln(os.Stderr, "verification failed")
		os.Exit(7)
	case "timeout":
		time.Sleep(30 * time.Second)
	case "large":
		fmt.Fprint(os.Stdout, strings.Repeat("x", 16<<10))
	default:
		os.Exit(9)
	}
	os.Exit(0)
}

func TestRunnerClassifiesPassFailureTimeoutAndCleansOwnedRoot(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("process helper invocation is covered by Windows cross-build; native Job behavior has runtime package tests")
	}
	temporaryParent := t.TempDir()
	workspace := filepath.Join(t.TempDir(), "candidate")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	executableSHA, err := executableDigest(executable)
	if err != nil {
		t.Fatal(err)
	}
	runner := Runner{TemporaryParent: temporaryParent}
	for name, expected := range map[string]Outcome{
		"pass": OutcomePassed, "fail": OutcomeFailed,
		"timeout": OutcomeTimeout, "large": OutcomeFailed,
	} {
		t.Run(name, func(t *testing.T) {
			timeout := 2 * time.Second
			limit := int64(4096)
			if name == "timeout" {
				timeout = 150 * time.Millisecond
			}
			if name == "large" {
				limit = 1024
			}
			result, err := runner.Run(context.Background(), ResolvedProfile{
				Executable: executable, ExecutableDigest: executableSHA,
				Arguments: []string{"-test.run=TestVerificationHelperProcess", "--", name, workspace, temporaryParent},
				Timeout:   timeout, OutputLimitBytes: limit,
			}, workspace)
			if err != nil {
				t.Fatal(err)
			}
			if result.Outcome != expected || result.StartedAt.IsZero() || result.FinishedAt.IsZero() || len(result.Log) == 0 {
				t.Fatalf("unexpected result: %#v", result)
			}
			if name == "pass" && (result.ExitCode == nil || *result.ExitCode != 0) {
				t.Fatalf("passing exit code missing: %#v", result.ExitCode)
			}
			if name == "fail" && (result.ExitCode == nil || *result.ExitCode != 7) {
				t.Fatalf("failing exit code missing: %#v", result.ExitCode)
			}
			if name == "timeout" && result.ExitCode != nil {
				t.Fatalf("timeout leaked process termination code: %#v", result.ExitCode)
			}
			var log logEnvelope
			if err := json.Unmarshal(result.Log, &log); err != nil {
				t.Fatal(err)
			}
			if strings.Contains(log.Stdout+log.Stderr, workspace) || strings.Contains(log.Stdout+log.Stderr, temporaryParent) {
				t.Fatalf("local path leaked in log: %s", result.Log)
			}
			entries, err := os.ReadDir(temporaryParent)
			if err != nil || len(entries) != 0 {
				t.Fatalf("verification root leaked: %v %#v", err, entries)
			}
		})
	}
}

func TestRunnerCancellationCannotPass(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("native Windows process-tree behavior is covered separately")
	}
	workspace := filepath.Join(t.TempDir(), "candidate")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	executable, _ := os.Executable()
	executableSHA, _ := executableDigest(executable)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	result, err := (Runner{TemporaryParent: t.TempDir()}).Run(ctx, ResolvedProfile{Executable: executable,
		ExecutableDigest: executableSHA,
		Arguments:        []string{"-test.run=TestVerificationHelperProcess", "--", "pass", workspace, workspace},
		Timeout:          time.Second, OutputLimitBytes: 4096}, workspace)
	if err != nil {
		t.Fatal(err)
	}
	if result.Outcome == OutcomePassed {
		t.Fatal("canceled verification passed")
	}
	if result.ExitCode != nil {
		t.Fatalf("canceled verification leaked process termination code: %#v", result.ExitCode)
	}
}

func TestRunnerSpawnFailureRetainsFailureEvidenceAndCleansOwnedRoot(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("native Windows process startup failure is covered by the process package")
	}
	workspace := filepath.Join(t.TempDir(), "candidate")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	nonExecutable := filepath.Join(t.TempDir(), "verifier")
	if err := os.WriteFile(nonExecutable, []byte("not executable\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	digest, err := executableDigest(nonExecutable)
	if err != nil {
		t.Fatal(err)
	}
	temporaryParent := t.TempDir()
	result, err := (Runner{TemporaryParent: temporaryParent}).Run(
		context.Background(),
		ResolvedProfile{
			Executable:       nonExecutable,
			ExecutableDigest: digest,
			Timeout:          time.Second,
			OutputLimitBytes: 4096,
		},
		workspace,
	)
	if err != nil {
		t.Fatal(err)
	}
	if result.Outcome != OutcomeFailed || result.ExitCode != nil || len(result.Log) == 0 {
		t.Fatalf("spawn failure was not retained safely: %#v", result)
	}
	var log logEnvelope
	if err := json.Unmarshal(result.Log, &log); err != nil {
		t.Fatal(err)
	}
	if log.Spawned {
		t.Fatalf("failed process was reported as spawned: %s", result.Log)
	}
	if entries, err := os.ReadDir(temporaryParent); err != nil || len(entries) != 0 {
		t.Fatalf("spawn failure leaked verification root: %#v %v", entries, err)
	}
}

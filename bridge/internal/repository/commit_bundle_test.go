package repository

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"convenewire.dev/bridge/internal/artifact"
	execution "convenewire.dev/contracts/generated/go/execution"
)

func commitBundleFixture(t *testing.T, format string, inputs, unchanged bool) (*fixture, PreparedWorkspace, CapturedRepository) {
	t.Helper()
	f := gitFixture(t, format, Limits{})
	f.write(t, "private/secret.txt", "unchanged private source body\n")
	f.git(t, f.sourcePath, "add", "--all")
	f.git(t, f.sourcePath, "commit", "-m", "PRIVATE_PREREQUISITE_SUBJECT")
	f.base = f.git(t, f.sourcePath, "rev-parse", "HEAD")
	r := request(f.base, "commit_bundle")
	r.ScopePolicy.AllowedPaths = []string{"src"}
	r.ScopePolicy.ForbiddenPaths = []string{"private"}
	if inputs {
		r.Inputs = []PatchInput{patch("base", "upstream", "bundle_upstream")}
	}
	ready := mustPrepare(t, f, r)
	if !unchanged {
		writeWork(t, ready, "src/app.txt", "captured commit output\n")
	}
	captured := mustCapture(t, f, captureRequest(ready, "commit_bundle"))
	return f, ready, captured
}

func TestCapturedCommitBundleRoundtrip(t *testing.T) {
	for _, format := range []string{"sha1", "sha256"} {
		for _, inputs := range []bool{false, true} {
			name := format + "/base"
			if inputs {
				name = format + "/prepared_inputs"
			}
			t.Run(name, func(t *testing.T) {
				f, ready, captured := commitBundleFixture(t, format, inputs, false)
				before := f.git(t, ready.Path, "status", "--porcelain=v1")
				bundle, err := f.preparer.ReadCapturedCommitBundle(context.Background(), captured.OperationID, captured.Digest)
				if err != nil {
					t.Fatal(err)
				}
				header := commitBundleHeader(format, ready.outputBase(), captured.CandidateCommit)
				if !bytes.HasPrefix(bundle, header) || bytes.Contains(bundle, []byte("PRIVATE_PREREQUISITE_SUBJECT")) {
					t.Fatal("bundle identity or prerequisite comment changed")
				}
				if inputs && ready.outputBase() == f.base {
					t.Fatal("prepared input prerequisite was lost")
				}
				current, err := os.ReadFile(filepath.Join(ready.Path, "src", "app.txt"))
				if err != nil || string(current) != "captured commit output\n" {
					t.Fatal("bundle collection changed the live file", err)
				}
				bundlePath := filepath.Join(f.root, "candidate.bundle")
				if err := os.WriteFile(bundlePath, bundle, 0o600); err != nil {
					t.Fatal(err)
				}
				// Clone the exact prepared prerequisite into a separate repository.
				// This is a real Git consumer, not the future cross-Bridge admission.
				target := filepath.Join(f.root, "consumer.git")
				f.git(t, f.root, "clone", "--no-local", "--bare", "--", ready.GitDirectory, target)
				refs := f.git(t, target, "show-ref")
				f.git(t, target, "bundle", "verify", bundlePath)
				f.git(t, target, "bundle", "unbundle", bundlePath)
				if f.git(t, target, "show-ref") != refs || f.git(t, target, "rev-parse", captured.CandidateCommit+"^{tree}") != captured.CandidateTree ||
					f.git(t, target, "rev-parse", captured.CandidateCommit+"^") != ready.outputBase() ||
					f.git(t, target, "show", captured.CandidateCommit+":src/app.txt") != "captured commit output" {
					t.Fatal("bundle changed refs or failed exact commit/tree roundtrip")
				}
				f.git(t, target, "fsck", "--strict", "--no-reflogs", captured.CandidateCommit)
				// Inspect the actual transmitted pack, not a string search over
				// compressed bytes: unchanged source blobs and base history are absent.
				pack := bundle[len(header):]
				indexed, err := f.preparer.git.run(context.Background(), target, bytes.NewReader(pack), 1024,
					"index-pack", "--stdin", "--fix-thin")
				if err != nil {
					t.Fatal(err)
				}
				fields := strings.Fields(string(indexed))
				if len(fields) != 2 || !validObject(fields[1], format) {
					t.Fatal("invalid pack identity")
				}
				objects := f.git(t, target, "verify-pack", "-v", filepath.Join(target, "objects", "pack", "pack-"+fields[1]+".idx"))
				transmitted := map[string]bool{}
				for _, line := range strings.Split(objects, "\n") {
					entry := strings.Fields(line)
					if len(entry) < 5 || !validObject(entry[0], format) {
						continue
					}
					offset, err := strconv.ParseInt(entry[4], 10, 64)
					if err != nil {
						t.Fatal(err)
					}
					// --fix-thin appends prerequisite delta bases. Do not mistake
					// those receiver-owned objects for bytes present in the bundle.
					if offset < int64(len(pack)-len(captured.CandidateCommit)/2) {
						transmitted[entry[0]] = true
					}
				}
				privateBlob := f.git(t, f.sourcePath, "rev-parse", f.base+":private/secret.txt")
				if len(transmitted) != int(binary.BigEndian.Uint32(pack[8:12])) || transmitted[privateBlob] ||
					transmitted[ready.outputBase()] || !transmitted[captured.CandidateCommit] {
					t.Fatal("transmitted pack copied prerequisite content or lost candidate")
				}
				if inputs {
					missing := filepath.Join(f.root, "missing-prepared.git")
					f.git(t, f.root, "clone", "--no-local", "--bare", "--", f.sourcePath, missing)
					if _, err := f.preparer.git.run(context.Background(), missing, nil, 16<<10, "bundle", "verify", bundlePath); err == nil {
						t.Fatal("original base silently substituted for prepared input prerequisite")
					}
				}
				writeWork(t, ready, "src/app.txt", "later uncollected output\n")
				if err := f.preparer.Close(); err != nil {
					t.Fatal(err)
				}
				f.preparer, err = NewPreparer(f.state, f.executable, Limits{})
				if err != nil {
					t.Fatal(err)
				}
				replayed, err := f.preparer.ReadCapturedCommitBundle(context.Background(), captured.OperationID, captured.Digest)
				if err != nil || !bytes.Equal(bundle, replayed) {
					t.Fatal("reopen changed retained commit content", err)
				}
				if before != f.git(t, ready.Path, "status", "--porcelain=v1") || f.git(t, f.sourcePath, "status", "--porcelain=v1") != "" {
					t.Fatal("bundle mutated a working directory")
				}
				current, err = os.ReadFile(filepath.Join(ready.Path, "src", "app.txt"))
				if err != nil || string(current) != "later uncollected output\n" {
					t.Fatal("retained bundle replay overwrote later work", err)
				}
			})
		}
	}
}

func TestCapturedCommitBundleNoCodeDelta(t *testing.T) {
	for _, format := range []string{"sha1", "sha256"} {
		t.Run(format, func(t *testing.T) {
			f, ready, captured := commitBundleFixture(t, format, false, true)
			if captured.PatchBytes != 0 {
				t.Fatal("fixture must have no code delta")
			}
			bundle, err := f.preparer.ReadCapturedCommitBundle(context.Background(), captured.OperationID, captured.Digest)
			if err != nil || !bytes.HasPrefix(bundle, commitBundleHeader(format, ready.outputBase(), captured.CandidateCommit)) {
				t.Fatal("empty delta lost its actual commit object", err)
			}
			pack := bundle[len(commitBundleHeader(format, ready.outputBase(), captured.CandidateCommit)):]
			if binary.BigEndian.Uint32(pack[8:12]) != 1 {
				t.Fatal("unchanged tree was retransmitted")
			}
		})
	}
}

func TestCapturedCommitOnlyPublicationAcceptsNoCodeDelta(t *testing.T) {
	for _, format := range []string{"sha1", "sha256"} {
		t.Run(format, func(t *testing.T) {
			f, _, captured, publication := reportSeed(t, format, "# Review\n", "{}", func(f *fixture, manifest *execution.GovernedExecutionManifest) {
				f.write(t, "src/app.txt", "implemented with reports\n")
				f.write(t, "tests/review.md", "# Review\n")
				f.write(t, "tests/results.json", "{}")
				f.git(t, f.sourcePath, "add", "--all")
				f.git(t, f.sourcePath, "commit", "-m", "unchanged commit-output fixture")
				manifest.Outputs = []execution.GovernedExecutionManifestOutput{{SlotKey: "commit", Kind: execution.Commit, Required: true}}
			})
			if captured.PatchBytes != 0 {
				t.Fatal("fixture unexpectedly changed code")
			}
			publication.Outputs = []CaptureOutputDescription{{SlotKey: "commit", Title: "Candidate", Summary: "Captured commit, not acceptance"}}
			transport := &reportTransport{sources: map[string]artifact.Source{}}
			checkpoint, err := f.preparer.PublishCaptured(context.Background(), publication, transport)
			if err != nil {
				t.Fatal(err)
			}
			source := transport.sources["commit"]
			bundle, err := f.preparer.ReadCapturedCommitBundle(context.Background(), captured.OperationID, captured.Digest)
			if err != nil || len(checkpoint.Outputs) != 1 || checkpoint.Outputs[0].Artifact.Kind != execution.Commit ||
				source.MediaType != "application/x-git-bundle" || !bytes.Equal(source.Bytes, bundle) ||
				checkpoint.Outputs[0].Artifact.ContentDigest != source.SHA256 {
				t.Fatal("commit-only publication lost its exact sealed bytes", err)
			}
		})
	}
}

func TestCapturedCommitBundleRejectsChangedRetention(t *testing.T) {
	for _, change := range []string{"bytes", "receipt", "missing content", "partial conflict", "capture digest", "ref", "config"} {
		t.Run(change, func(t *testing.T) {
			f, _, captured := commitBundleFixture(t, "sha1", false, false)
			bundle, err := f.preparer.ReadCapturedCommitBundle(context.Background(), captured.OperationID, captured.Digest)
			if err != nil {
				t.Fatal(err)
			}
			content := filepath.Join(f.preparer.capturePath(captured.OperationID), "commit.bundle")
			receipt := f.preparer.claimPath("commit-bundle", captured.OperationID)
			expected := captured.Digest
			switch change {
			case "bytes", "partial conflict":
				bundle[len(bundle)-1] ^= 1
				if err := os.WriteFile(content, bundle, 0o600); err != nil {
					t.Fatal(err)
				}
				if change == "partial conflict" {
					if err := os.Remove(receipt); err != nil {
						t.Fatal(err)
					}
				}
			case "receipt":
				if err := os.WriteFile(receipt, []byte(`{"Version":999}`), 0o600); err != nil {
					t.Fatal(err)
				}
			case "missing content":
				if err := os.Remove(content); err != nil {
					t.Fatal(err)
				}
			case "capture digest":
				expected = strings.Repeat("f", 64)
			case "ref":
				if err := os.Remove(receipt); err != nil {
					t.Fatal(err)
				}
				f.git(t, filepath.Join(f.preparer.capturePath(captured.OperationID), "git"), "update-ref", captureBundleRef, f.base)
			case "config":
				f.git(t, filepath.Join(f.preparer.capturePath(captured.OperationID), "git"), "config", "core.abbrev", "8")
			}
			if _, err := f.preparer.ReadCapturedCommitBundle(context.Background(), captured.OperationID, expected); err == nil {
				t.Fatal("changed retained state was accepted")
			}
		})
	}
}

func TestCapturedCommitBundleRecoversContentBeforeReceipt(t *testing.T) {
	f, _, captured := commitBundleFixture(t, "sha1", false, false)
	bundle, err := f.preparer.ReadCapturedCommitBundle(context.Background(), captured.OperationID, captured.Digest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(f.preparer.claimPath("commit-bundle", captured.OperationID)); err != nil {
		t.Fatal(err)
	}
	if err := f.preparer.Close(); err != nil {
		t.Fatal(err)
	}
	f.preparer, err = NewPreparer(f.state, f.executable, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	recovered, err := f.preparer.ReadCapturedCommitBundle(context.Background(), captured.OperationID, captured.Digest)
	if err != nil || !bytes.Equal(bundle, recovered) {
		t.Fatal("identical partial retention could not recover", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := f.preparer.ReadCapturedCommitBundle(ctx, captured.OperationID, captured.Digest); !errors.Is(err, context.Canceled) {
		t.Fatal("canceled operation was ignored", err)
	}
}

func TestCapturedCommitBundleSurvivesCheckpointCleanup(t *testing.T) {
	f, _, captured, publication := reportSeed(t, "sha1", "# Review\n", "{}")
	bundle, err := f.preparer.ReadCapturedCommitBundle(context.Background(), captured.OperationID, captured.Digest)
	if err != nil {
		t.Fatal(err)
	}
	transport := &reportTransport{sources: map[string]artifact.Source{}}
	checkpoint, err := f.preparer.PublishCaptured(context.Background(), publication, transport)
	if err != nil {
		t.Fatal(err)
	}
	preview, err := f.preparer.PreviewCleanup(context.Background(), "op_bundle_cleanup0001", checkpoint, stoppedCleanupFixture)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.preparer.CleanupWorkspace(context.Background(), CleanupRequest{OperationID: preview.OperationID,
		Checkpoint: checkpoint, ExpectedPreviewDigest: preview.Digest}, stoppedCleanupFixture); err != nil {
		t.Fatal(err)
	}
	retained, err := f.preparer.ReadCapturedCommitBundle(context.Background(), captured.OperationID, captured.Digest)
	if err != nil || !bytes.Equal(bundle, retained) {
		t.Fatal("retired workspace lost its retained commit objects", err)
	}
}

func TestCommitBundleEnvelopeRejectsSubstitutionsAndOversize(t *testing.T) {
	f, ready, captured := commitBundleFixture(t, "sha256", false, false)
	bundle, err := f.preparer.ReadCapturedCommitBundle(context.Background(), captured.OperationID, captured.Digest)
	if err != nil {
		t.Fatal(err)
	}
	for _, change := range []string{"format", "prerequisite", "candidate", "extra ref", "extra capability", "checksum", "version"} {
		t.Run(change, func(t *testing.T) {
			modified := bytes.Clone(bundle)
			switch change {
			case "format":
				modified = bytes.Replace(modified, []byte("@object-format=sha256"), []byte("@object-format=sha1"), 1)
			case "prerequisite":
				modified = bytes.Replace(modified, []byte("-"+ready.outputBase()), []byte("-"+strings.Repeat("f", 64)), 1)
			case "candidate":
				modified = bytes.Replace(modified, []byte(captured.CandidateCommit+" "), []byte(strings.Repeat("f", 64)+" "), 1)
			case "extra ref":
				modified = bytes.Replace(modified, []byte("\n\nPACK"), []byte("\n"+captured.CandidateCommit+" refs/heads/other\n\nPACK"), 1)
			case "extra capability":
				modified = bytes.Replace(modified, []byte("@object-format=sha256\n"), []byte("@object-format=sha256\n@filter=blob:none\n"), 1)
			case "checksum":
				modified[len(modified)-1] ^= 1
			case "version":
				modified = bytes.Replace(modified, []byte("# v3"), []byte("# v2"), 1)
			}
			if _, err := normalizeCommitBundle(modified, "sha256", ready.outputBase(), captured.CandidateCommit); err == nil {
				t.Fatal("changed bundle envelope was accepted")
			}
		})
	}
	// A synthetic checksummed pack tests the envelope's independent byte bound;
	// the real-Git roundtrips above, not this pack, prove object validity.
	pack := make([]byte, artifact.MaximumSourceBytes)
	copy(pack, []byte("PACK"))
	binary.BigEndian.PutUint32(pack[4:8], 2)
	binary.BigEndian.PutUint32(pack[8:12], 1)
	hash := sha256.Sum256(pack[:len(pack)-sha256.Size])
	copy(pack[len(pack)-sha256.Size:], hash[:])
	if _, err := normalizeCommitBundle(append(commitBundleHeader("sha256", ready.outputBase(), captured.CandidateCommit), pack...),
		"sha256", ready.outputBase(), captured.CandidateCommit); !errors.Is(err, ErrLimit) {
		t.Fatal("oversized bundle envelope was accepted", err)
	}
}

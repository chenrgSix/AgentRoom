package repository

import (
	"bytes"
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"convenewire.dev/bridge/internal/artifact"
)

const captureBundleRef = "refs/heads/codex/capture"

// This is an owner-local retention receipt, not an execution or merge grant.
// The content itself uses the standard Git bundle v3 format, not a wire model.
type commitBundleRecord struct {
	Version            int
	CaptureDigest      string
	PrerequisiteCommit string
	ObjectFormat       string
	ContentDigest      string
	ByteLength         int64
}

func commitBundleHeader(format, prerequisite, candidate string) []byte {
	return []byte("# v3 git bundle\n@object-format=" + format + "\n-" + prerequisite +
		" ConveneWire prepared base\n" + candidate + " " + captureBundleRef + "\n\n")
}

// Validate only our closed bundle envelope and pack checksum here. Git remains
// responsible for object/ancestry verification during actual materialization.
func validCommitBundlePack(pack []byte, format string) bool {
	width := sha1.Size
	if format == "sha256" {
		width = sha256.Size
	} else if format != "sha1" {
		return false
	}
	if len(pack) <= 12+width || !bytes.Equal(pack[:4], []byte("PACK")) ||
		binary.BigEndian.Uint32(pack[4:8]) != 2 || binary.BigEndian.Uint32(pack[8:12]) == 0 {
		return false
	}
	content, trailer := pack[:len(pack)-width], pack[len(pack)-width:]
	if format == "sha256" {
		hash := sha256.Sum256(content)
		return bytes.Equal(hash[:], trailer)
	}
	hash := sha1.Sum(content)
	return bytes.Equal(hash[:], trailer)
}

func normalizeCommitBundle(raw []byte, format, prerequisite, candidate string) ([]byte, error) {
	end := bytes.Index(raw, []byte("\n\n"))
	if end < 0 || end > 64<<10 || !validObject(prerequisite, format) || !validObject(candidate, format) || prerequisite == candidate {
		return nil, ErrChanged
	}
	lines := strings.Split(string(raw[:end]), "\n")
	if len(lines) != 4 || lines[0] != "# v3 git bundle" || lines[1] != "@object-format="+format ||
		!strings.HasPrefix(lines[2], "-"+prerequisite+" ") || lines[3] != candidate+" "+captureBundleRef {
		return nil, ErrChanged
	}
	pack := raw[end+2:]
	if !validCommitBundlePack(pack, format) {
		return nil, ErrChanged
	}
	// Git puts the prerequisite's commit subject in this comment. Replace it
	// with fixed text so unrelated source history never becomes output prose.
	header := commitBundleHeader(format, prerequisite, candidate)
	if len(header)+len(pack) > artifact.MaximumSourceBytes {
		return nil, ErrLimit
	}
	return append(header, pack...), nil
}

// ReadCapturedCommitBundle returns actual retained Git objects with an exact
// prepared-base prerequisite. It neither copies the whole source repository nor
// moves a ref, and it does not grant transport, import or Runtime authority.
func (p *Preparer) ReadCapturedCommitBundle(ctx context.Context, operationID, expectedDigest string) ([]byte, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if _, err := p.readCapturedPatchLocked(ctx, operationID, expectedDigest); err != nil {
		return nil, err
	}
	var captured CapturedRepository
	if err := readJSONSized(p.claimPath("capture", operationID), &captured, 32<<20); err != nil {
		return nil, err
	}
	claimed := captured.Digest
	captured.Digest = ""
	if claimed != expectedDigest || digest(captured) != claimed || captured.OperationID != operationID {
		return nil, ErrChanged
	}
	captured.Digest = claimed
	source, err := p.verifiedCapturedSource(ctx, captured)
	if err != nil {
		return nil, err
	}
	return p.readCommitBundleLocked(ctx, captured, source)
}

func (p *Preparer) readCommitBundleLocked(ctx context.Context, captured CapturedRepository, source capturedSource) ([]byte, error) {
	expected := commitBundleRecord{Version: 1, CaptureDigest: captured.Digest,
		PrerequisiteCommit: source.Ready.outputBase(), ObjectFormat: source.ObjectFormat}
	contentPath := filepath.Join(p.capturePath(captured.OperationID), "commit.bundle")
	receiptPath := p.claimPath("commit-bundle", captured.OperationID)
	var receipt commitBundleRecord
	if err := readJSON(receiptPath, &receipt); err == nil {
		contentHash, size := receipt.ContentDigest, receipt.ByteLength
		receipt.ContentDigest, receipt.ByteLength = "", 0
		if receipt != expected || !sha256ID.MatchString(contentHash) || size < 1 || size > artifact.MaximumSourceBytes {
			return nil, ErrChanged
		}
		raw, err := readRegular(contentPath, artifact.MaximumSourceBytes)
		if err != nil {
			return nil, err
		}
		hash := sha256.Sum256(raw)
		normalized, err := normalizeCommitBundle(raw, source.ObjectFormat, expected.PrerequisiteCommit, captured.CandidateCommit)
		if err != nil || int64(len(raw)) != size || hex.EncodeToString(hash[:]) != contentHash || !bytes.Equal(raw, normalized) {
			return nil, ErrChanged
		}
		return raw, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	// Only the capture-owned ref is advertised. Its current value must match the
	// sealed candidate, and the generated header is checked again after Git exits.
	head, err := p.git.text(ctx, source.GitDirectory, "show-ref", "--verify", "--hash", captureBundleRef)
	if err != nil || head != captured.CandidateCommit {
		return nil, ErrChanged
	}
	raw, err := p.git.run(ctx, source.GitDirectory, nil, artifact.MaximumSourceBytes,
		"bundle", "create", "--version=3", "-", captureBundleRef, "^"+expected.PrerequisiteCommit)
	if err != nil {
		return nil, err
	}
	raw, err = normalizeCommitBundle(raw, source.ObjectFormat, expected.PrerequisiteCommit, captured.CandidateCommit)
	if err != nil {
		return nil, err
	}
	if err := p.checkOwner(); err != nil {
		return nil, err
	}
	// A crash after content installation but before its receipt is recoverable
	// only when recomputation still produces the exact same immutable bytes.
	if existing, err := readRegular(contentPath, artifact.MaximumSourceBytes); err == nil {
		if !bytes.Equal(raw, existing) {
			return nil, ErrChanged
		}
	} else if errors.Is(err, os.ErrNotExist) {
		if err := writeExclusive(contentPath, raw); err != nil {
			return nil, err
		}
	} else {
		return nil, err
	}
	hash := sha256.Sum256(raw)
	expected.ContentDigest, expected.ByteLength = hex.EncodeToString(hash[:]), int64(len(raw))
	if err := ensureExactJSON(receiptPath, expected); err != nil {
		return nil, err
	}
	return raw, nil
}

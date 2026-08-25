package artifact

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"agentroom.dev/bridge/internal/workspace"
)

const MaximumSourceBytes = 4 << 20

type Source struct {
	Bytes               []byte
	FileName            string
	MediaType           string
	SHA256              string
	WorkspaceRef        string
	WorkspaceGeneration string
}

func Capture(root, relativePath, artifactType string) (Source, error) {
	return capture(root, relativePath, artifactType, nil)
}

func capture(
	root, relativePath, artifactType string,
	afterFirstRead func(string) error,
) (Source, error) {
	if strings.TrimSpace(relativePath) != relativePath || relativePath == "" ||
		filepath.IsAbs(relativePath) || strings.Contains(relativePath, "\\") {
		return Source{}, fmt.Errorf("Artifact file must be a clean Workspace-relative path")
	}
	cleanRelative := filepath.Clean(relativePath)
	if cleanRelative == "." || cleanRelative == ".." ||
		strings.HasPrefix(cleanRelative, ".."+string(filepath.Separator)) {
		return Source{}, fmt.Errorf("Artifact file must stay inside its Workspace")
	}
	resolvedRoot, err := filepath.Abs(filepath.Clean(root))
	if err != nil {
		return Source{}, fmt.Errorf("resolve Workspace: %w", err)
	}
	resolvedRoot, err = filepath.EvalSymlinks(resolvedRoot)
	if err != nil {
		return Source{}, fmt.Errorf("resolve Workspace links: %w", err)
	}
	target := filepath.Join(resolvedRoot, cleanRelative)
	contained, err := filepath.Rel(resolvedRoot, target)
	if err != nil || contained == ".." ||
		strings.HasPrefix(contained, ".."+string(filepath.Separator)) {
		return Source{}, fmt.Errorf("Artifact file escaped its Workspace")
	}
	canonicalTarget, err := filepath.EvalSymlinks(target)
	if err != nil {
		return Source{}, fmt.Errorf("resolve Artifact file: %w", err)
	}
	if canonicalTarget != target {
		return Source{}, fmt.Errorf("Artifact file must not traverse symbolic links")
	}
	fileName := filepath.Base(target)
	if !safeFileName(fileName) {
		return Source{}, fmt.Errorf("Artifact file name is not alias-safe")
	}
	mediaType, err := mediaTypeFor(artifactType, fileName)
	if err != nil {
		return Source{}, err
	}
	beforeWorkspace, err := workspace.Inspect(resolvedRoot)
	if err != nil {
		return Source{}, err
	}
	before, err := os.Lstat(target)
	if err != nil {
		return Source{}, fmt.Errorf("inspect Artifact file: %w", err)
	}
	if before.Mode()&os.ModeSymlink != 0 || !before.Mode().IsRegular() {
		return Source{}, fmt.Errorf("Artifact source must be one regular file")
	}
	if before.Size() < 1 || before.Size() > MaximumSourceBytes {
		return Source{}, fmt.Errorf("Artifact source must contain 1 to %d bytes", MaximumSourceBytes)
	}
	opened, err := os.Open(target)
	if err != nil {
		return Source{}, fmt.Errorf("open Artifact file: %w", err)
	}
	defer opened.Close()
	openedInfo, err := opened.Stat()
	if err != nil || !openedInfo.Mode().IsRegular() || !os.SameFile(before, openedInfo) {
		return Source{}, fmt.Errorf("Artifact source changed before capture")
	}
	first, err := io.ReadAll(io.LimitReader(opened, MaximumSourceBytes+1))
	if err != nil {
		return Source{}, fmt.Errorf("read Artifact file: %w", err)
	}
	if len(first) < 1 || len(first) > MaximumSourceBytes {
		return Source{}, fmt.Errorf("Artifact source exceeded its size bound")
	}
	if afterFirstRead != nil {
		if err := afterFirstRead(target); err != nil {
			return Source{}, err
		}
	}
	if _, err := opened.Seek(0, io.SeekStart); err != nil {
		return Source{}, fmt.Errorf("rewind Artifact file: %w", err)
	}
	second, err := io.ReadAll(io.LimitReader(opened, MaximumSourceBytes+1))
	if err != nil || !bytes.Equal(first, second) {
		return Source{}, fmt.Errorf("Artifact source changed during capture")
	}
	after, err := opened.Stat()
	if err != nil || !os.SameFile(before, after) || before.Size() != after.Size() ||
		before.ModTime() != after.ModTime() || before.Mode() != after.Mode() {
		return Source{}, fmt.Errorf("Artifact source changed during capture")
	}
	afterWorkspace, err := workspace.Inspect(resolvedRoot)
	if err != nil {
		return Source{}, err
	}
	if beforeWorkspace != afterWorkspace {
		return Source{}, fmt.Errorf("Workspace generation changed during Artifact capture")
	}
	digest := sha256.Sum256(first)
	return Source{
		Bytes:               first,
		FileName:            fileName,
		MediaType:           mediaType,
		SHA256:              hex.EncodeToString(digest[:]),
		WorkspaceRef:        beforeWorkspace.WorkspaceRef,
		WorkspaceGeneration: beforeWorkspace.Generation,
	}, nil
}

func safeFileName(fileName string) bool {
	if len(fileName) < 1 || len(fileName) > 255 {
		return false
	}
	for index, value := range []byte(fileName) {
		if (value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z') ||
			(value >= '0' && value <= '9') ||
			(index > 0 && (value == '.' || value == '_' || value == '-')) {
			continue
		}
		return false
	}
	return true
}

func mediaTypeFor(artifactType, fileName string) (string, error) {
	lower := strings.ToLower(fileName)
	switch artifactType {
	case "patch":
		if strings.HasSuffix(lower, ".patch") || strings.HasSuffix(lower, ".diff") {
			return "text/x-diff", nil
		}
	case "document":
		if strings.HasSuffix(lower, ".md") || strings.HasSuffix(lower, ".markdown") {
			return "text/markdown", nil
		}
	case "test_result":
		if strings.HasSuffix(lower, ".json") {
			return "application/json", nil
		}
	default:
		return "", fmt.Errorf("Artifact type must be patch, document, or test_result")
	}
	return "", fmt.Errorf("Artifact file extension does not match type %s", artifactType)
}

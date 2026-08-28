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

	"convenewire.dev/bridge/internal/workspace"
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

// SourcePlan contains only path metadata observed before central authorization.
// The source bytes are not opened or read until Capture is called after an
// accepted read_source lease.
type SourcePlan struct {
	FileName            string
	MediaType           string
	WorkspaceRef        string
	WorkspaceGeneration string
	artifactType        string
	cleanRelativePath   string
	resolvedRoot        string
	observed            os.FileInfo
	openSource          func(string) (*os.File, error)
}

func PlanSource(root, relativePath, artifactType string) (SourcePlan, error) {
	if strings.TrimSpace(relativePath) != relativePath || relativePath == "" ||
		filepath.IsAbs(relativePath) || strings.Contains(relativePath, "\\") {
		return SourcePlan{}, fmt.Errorf("Artifact file must be a clean Workspace-relative path")
	}
	cleanRelative := filepath.Clean(relativePath)
	if cleanRelative == "." || cleanRelative == ".." ||
		strings.HasPrefix(cleanRelative, ".."+string(filepath.Separator)) {
		return SourcePlan{}, fmt.Errorf("Artifact file must stay inside its Workspace")
	}
	resolvedRoot, err := filepath.Abs(filepath.Clean(root))
	if err != nil {
		return SourcePlan{}, fmt.Errorf("resolve Workspace: %w", err)
	}
	resolvedRoot, err = filepath.EvalSymlinks(resolvedRoot)
	if err != nil {
		return SourcePlan{}, fmt.Errorf("resolve Workspace links: %w", err)
	}
	target := filepath.Join(resolvedRoot, cleanRelative)
	contained, err := filepath.Rel(resolvedRoot, target)
	if err != nil || contained == ".." ||
		strings.HasPrefix(contained, ".."+string(filepath.Separator)) {
		return SourcePlan{}, fmt.Errorf("Artifact file escaped its Workspace")
	}
	canonicalTarget, err := filepath.EvalSymlinks(target)
	if err != nil {
		return SourcePlan{}, fmt.Errorf("resolve Artifact file: %w", err)
	}
	if canonicalTarget != target {
		return SourcePlan{}, fmt.Errorf("Artifact file must not traverse symbolic links")
	}
	fileName := filepath.Base(target)
	if !safeFileName(fileName) {
		return SourcePlan{}, fmt.Errorf("Artifact file name is not alias-safe")
	}
	mediaType, err := mediaTypeFor(artifactType, fileName)
	if err != nil {
		return SourcePlan{}, err
	}
	workspaceSnapshot, err := workspace.Inspect(resolvedRoot)
	if err != nil {
		return SourcePlan{}, err
	}
	observed, err := os.Lstat(target)
	if err != nil {
		return SourcePlan{}, fmt.Errorf("inspect Artifact file: %w", err)
	}
	if observed.Mode()&os.ModeSymlink != 0 || !observed.Mode().IsRegular() {
		return SourcePlan{}, fmt.Errorf("Artifact source must be one regular file")
	}
	if observed.Size() < 1 || observed.Size() > MaximumSourceBytes {
		return SourcePlan{}, fmt.Errorf(
			"Artifact source must contain 1 to %d bytes",
			MaximumSourceBytes,
		)
	}
	return SourcePlan{
		FileName:            fileName,
		MediaType:           mediaType,
		WorkspaceRef:        workspaceSnapshot.WorkspaceRef,
		WorkspaceGeneration: workspaceSnapshot.Generation,
		artifactType:        artifactType,
		cleanRelativePath:   cleanRelative,
		resolvedRoot:        resolvedRoot,
		observed:            observed,
		openSource:          os.Open,
	}, nil
}

func Capture(plan SourcePlan) (Source, error) {
	return capture(plan, nil)
}

func capture(plan SourcePlan, afterFirstRead func(string) error) (Source, error) {
	target, beforeWorkspace, before, err := observeSourcePlan(plan)
	if err != nil {
		return Source{}, err
	}
	opened, err := plan.openSource(target)
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
	afterWorkspace, err := workspace.Inspect(plan.resolvedRoot)
	if err != nil {
		return Source{}, err
	}
	if beforeWorkspace != afterWorkspace {
		return Source{}, fmt.Errorf("Workspace generation changed during Artifact capture")
	}
	digest := sha256.Sum256(first)
	return Source{
		Bytes:               first,
		FileName:            plan.FileName,
		MediaType:           plan.MediaType,
		SHA256:              hex.EncodeToString(digest[:]),
		WorkspaceRef:        plan.WorkspaceRef,
		WorkspaceGeneration: plan.WorkspaceGeneration,
	}, nil
}

func (plan SourcePlan) leaseIdentity() string {
	return fmt.Sprintf(
		"%s\x00%s\x00%s\x00%d\x00%d\x00%d",
		plan.WorkspaceRef,
		plan.WorkspaceGeneration,
		plan.cleanRelativePath,
		plan.observed.Size(),
		plan.observed.ModTime().UTC().UnixNano(),
		plan.observed.Mode(),
	)
}

func validateSourcePlan(plan SourcePlan, artifactType string) error {
	if plan.observed == nil || plan.resolvedRoot == "" ||
		plan.openSource == nil || plan.cleanRelativePath == "" ||
		plan.artifactType != artifactType ||
		!strings.HasPrefix(plan.WorkspaceRef, "workspace_") ||
		len(plan.WorkspaceRef) != len("workspace_")+64 ||
		!validLowerHex(strings.TrimPrefix(plan.WorkspaceRef, "workspace_"), 64) ||
		!validLowerHex(plan.WorkspaceGeneration, 64) ||
		strings.ContainsAny(plan.FileName, "/\\") {
		return fmt.Errorf("Artifact source plan is invalid")
	}
	mediaType, err := mediaTypeFor(artifactType, plan.FileName)
	if err != nil || mediaType != plan.MediaType {
		return fmt.Errorf("Artifact source plan type or media type is invalid")
	}
	return nil
}

func observeSourcePlan(
	plan SourcePlan,
) (string, workspace.Snapshot, os.FileInfo, error) {
	if err := validateSourcePlan(plan, plan.artifactType); err != nil {
		return "", workspace.Snapshot{}, nil, err
	}
	target := filepath.Join(plan.resolvedRoot, plan.cleanRelativePath)
	canonicalTarget, err := filepath.EvalSymlinks(target)
	if err != nil || canonicalTarget != target {
		return "", workspace.Snapshot{}, nil,
			fmt.Errorf("Artifact source changed before capture")
	}
	currentWorkspace, err := workspace.Inspect(plan.resolvedRoot)
	if err != nil {
		return "", workspace.Snapshot{}, nil, err
	}
	if currentWorkspace.WorkspaceRef != plan.WorkspaceRef ||
		currentWorkspace.Generation != plan.WorkspaceGeneration {
		return "", workspace.Snapshot{}, nil,
			fmt.Errorf("Workspace generation changed before Artifact capture")
	}
	current, err := os.Lstat(target)
	if err != nil || !os.SameFile(plan.observed, current) ||
		current.Size() != plan.observed.Size() ||
		current.ModTime() != plan.observed.ModTime() ||
		current.Mode() != plan.observed.Mode() {
		return "", workspace.Snapshot{}, nil,
			fmt.Errorf("Artifact source changed before capture")
	}
	return target, currentWorkspace, current, nil
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

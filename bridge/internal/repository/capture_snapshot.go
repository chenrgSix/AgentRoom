package repository

import (
	"context"
	"encoding/hex"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"golang.org/x/text/unicode/norm"
)

type capturedFile struct {
	Path   string `json:"path"`
	Mode   string `json:"mode"`
	Object string `json:"object"`
	Size   int64  `json:"size"`
	Data   []byte `json:"-"`
}

type workSnapshot struct {
	Files       []capturedFile `json:"files"`
	Directories []string       `json:"directories"`
}

// Snapshot through os.Root instead of giving Git arbitrary Runtime-controlled
// paths. In particular, neither a symlink nor an ignored file can hide output.
// The caller must hold the Bridge's stopped-attempt fence; repeated observation
// detects drift, but cannot itself prove that a Runtime process has stopped.
func (g gitRunner) snapshotWork(ctx context.Context, work, format string, baseline []treeEntry, indexModes map[string]string) (workSnapshot, error) {
	root, err := os.OpenRoot(work)
	if err != nil {
		return workSnapshot{}, ErrChanged
	}
	defer root.Close()
	before := map[string]treeEntry{}
	for _, entry := range baseline {
		before[norm.NFC.String(entry.path)] = entry
	}
	result := workSnapshot{Files: []capturedFile{}, Directories: []string{}}
	seen := map[string]bool{}
	var total int64
	count := 0
	err = fs.WalkDir(root.FS(), ".", func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return ErrChanged
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if path == "." {
			return nil
		}
		if path == ".git" {
			if !entry.Type().IsRegular() {
				return ErrChanged
			}
			return nil
		}
		if !portablePath(path) {
			return ErrInvalid
		}
		count++
		if count > g.limits.Entries {
			return ErrLimit
		}
		key := strings.ToLower(norm.NFC.String(path))
		if seen[key] {
			return ErrInvalid
		}
		seen[key] = true
		original, existed := before[norm.NFC.String(path)]
		if entry.IsDir() {
			result.Directories = append(result.Directories, path)
			if existed && original.kind == "commit" {
				children, err := fs.ReadDir(root.FS(), path)
				if err != nil || len(children) != 0 {
					return ErrSpecialOutput
				}
				result.Files = append(result.Files, capturedFile{Path: original.path, Mode: "160000", Object: original.id})
				return fs.SkipDir
			}
			return nil
		}
		name := filepath.FromSlash(path)
		info, err := root.Lstat(name)
		if err != nil {
			return ErrChanged
		}
		item := capturedFile{Path: path, Mode: "100644"}
		if existed {
			item.Path = original.path
		}
		if info.Mode()&os.ModeSymlink != 0 {
			value, err := root.Readlink(name)
			if err != nil {
				return ErrChanged
			}
			item.Mode = "120000"
			item.Data = []byte(value)
		} else {
			if !info.Mode().IsRegular() {
				return ErrSpecialOutput
			}
			if info.Size() > g.limits.SnapshotBytes-total {
				return ErrLimit
			}
			file, err := root.Open(name)
			if err != nil {
				return ErrChanged
			}
			opened, err := file.Stat()
			if err != nil || !os.SameFile(info, opened) {
				file.Close()
				return ErrChanged
			}
			data, readErr := io.ReadAll(io.LimitReader(file, info.Size()+1))
			after, statErr := file.Stat()
			closeErr := file.Close()
			if readErr != nil || statErr != nil || closeErr != nil || int64(len(data)) != info.Size() ||
				after.Size() != info.Size() || !after.ModTime().Equal(info.ModTime()) {
				return ErrChanged
			}
			item.Data = data
			if info.Mode().Perm()&0o111 != 0 || (runtime.GOOS == "windows" && indexModes[item.Path] == "100755") {
				item.Mode = "100755"
			}
		}
		item.Size = int64(len(item.Data))
		if item.Size > g.limits.SnapshotBytes-total {
			return ErrLimit
		}
		total += item.Size
		hash := gitBlobHash(format, item.Size)
		hash.Write(item.Data)
		item.Object = hex.EncodeToString(hash.Sum(nil))
		result.Files = append(result.Files, item)
		return nil
	})
	if err != nil {
		return workSnapshot{}, err
	}
	sort.Slice(result.Files, func(i, j int) bool { return result.Files[i].Path < result.Files[j].Path })
	sort.Strings(result.Directories)
	return result, nil
}

// Changes deliberately represent a rename as a deletion plus an addition. Both
// path boundaries must be authorized; rename detection cannot hide its source.
type CapturedChange struct {
	Path         string `json:"path"`
	BeforeMode   string `json:"beforeMode"`
	AfterMode    string `json:"afterMode"`
	BeforeObject string `json:"beforeObject"`
	AfterObject  string `json:"afterObject"`
}

func changedFiles(baseline []treeEntry, snapshot workSnapshot, intent preparationIntent) ([]CapturedChange, error) {
	before := map[string]treeEntry{}
	after := map[string]capturedFile{}
	paths := map[string]bool{}
	for _, entry := range baseline {
		if entry.kind != "tree" {
			before[entry.path] = entry
			paths[entry.path] = true
		}
	}
	for _, entry := range snapshot.Files {
		after[entry.Path] = entry
		paths[entry.Path] = true
	}
	var ordered []string
	for path := range paths {
		ordered = append(ordered, path)
	}
	sort.Strings(ordered)
	changes := []CapturedChange{}
	for _, path := range ordered {
		old, next := before[path], after[path]
		if old.id == next.Object && old.mode == next.Mode {
			continue
		}
		if old.mode == "120000" || old.mode == "160000" || next.Mode == "120000" || next.Mode == "160000" {
			return nil, ErrSpecialOutput
		}
		if !allowedOutput(intent.ScopePolicy, path) {
			return nil, ErrScope
		}
		changes = append(changes, CapturedChange{Path: path, BeforeMode: old.mode, AfterMode: next.Mode, BeforeObject: old.id, AfterObject: next.Object})
	}
	return changes, nil
}

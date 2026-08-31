package repository

import (
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"hash"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"golang.org/x/text/unicode/norm"
)

// The highest-precedence owned attributes prevent checkout-time filters and
// built-in encodings/EOL/ident transformations. The candidate tree's exact bytes
// must be what verification and the eventual Runtime actually receive.
const exactCheckoutAttributes = "* -text -filter -ident -working-tree-encoding\n"

func gitBlobHash(format string, size int64) hash.Hash {
	var h hash.Hash
	if format == "sha256" {
		h = sha256.New()
	} else {
		h = sha1.New()
	}
	fmt.Fprintf(h, "blob %d\x00", size)
	return h
}

// Do not trust Git status/index flags as proof of clean bytes: assume-unchanged,
// skip-worktree and stale stat caches can hide a changed tracked file.
func (g gitRunner) verifyFiles(ctx context.Context, work, tree, format string) error {
	entries, err := g.entries(ctx, work, tree, format)
	if err != nil {
		return err
	}
	root, err := os.OpenRoot(work)
	if err != nil {
		return ErrChanged
	}
	defer root.Close()
	expected := map[string]treeEntry{}
	var total int64
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		expected[norm.NFC.String(entry.path)] = entry
		name := filepath.FromSlash(entry.path)
		info, err := root.Lstat(name)
		if err != nil {
			return ErrChanged
		}
		if entry.kind == "tree" || entry.kind == "commit" {
			if !info.IsDir() {
				return ErrChanged
			}
			continue
		}
		var object hash.Hash
		if entry.mode == "120000" {
			if info.Mode()&os.ModeSymlink == 0 {
				return ErrChanged
			}
			target, err := root.Readlink(name)
			if err != nil {
				return ErrChanged
			}
			if int64(len(target)) > g.limits.SnapshotBytes-total {
				return ErrLimit
			}
			total += int64(len(target))
			object = gitBlobHash(format, int64(len(target)))
			object.Write([]byte(target))
		} else {
			if !info.Mode().IsRegular() || (runtime.GOOS != "windows" && ((info.Mode().Perm()&0o111 != 0) != (entry.mode == "100755"))) {
				return ErrChanged
			}
			if info.Size() > g.limits.SnapshotBytes-total {
				return ErrLimit
			}
			total += info.Size()
			file, err := root.Open(name)
			if err != nil {
				return ErrChanged
			}
			opened, err := file.Stat()
			if err != nil || !os.SameFile(info, opened) {
				file.Close()
				return ErrChanged
			}
			object = gitBlobHash(format, info.Size())
			count, copyErr := io.Copy(object, io.LimitReader(file, info.Size()+1))
			closeErr := file.Close()
			if copyErr != nil || closeErr != nil || count != info.Size() {
				return ErrChanged
			}
		}
		if hex.EncodeToString(object.Sum(nil)) != entry.id {
			return ErrChanged
		}
	}
	return fs.WalkDir(root.FS(), ".", func(path string, entry fs.DirEntry, walkErr error) error {
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
		pin, ok := expected[norm.NFC.String(path)]
		if !ok || (entry.IsDir() != (pin.kind == "tree" || pin.kind == "commit")) {
			return ErrChanged
		}
		// Gitlinks are not recursively populated. Any file within one is unpinned
		// input, so WalkDir must keep walking rather than ignoring that directory.
		if strings.Contains(path, "\\") {
			return ErrChanged
		}
		return nil
	})
}

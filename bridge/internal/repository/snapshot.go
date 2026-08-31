package repository

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// Source is local-only: never serialize it in wire metadata or an Agent prompt.
// InspectSource must be invoked from an explicit owner-selected binding flow.
// Its physical pins survive ordinary commits but reject checkout replacement.
type Source struct {
	Root            string `json:"root"`
	GitDirectory    string `json:"gitDirectory"`
	CommonDirectory string `json:"commonDirectory"`
	ObjectFormat    string `json:"objectFormat"`
	RootIdentity    string `json:"rootIdentity"`
	GitIdentity     string `json:"gitIdentity"`
	CommonIdentity  string `json:"commonIdentity"`
}

func canonicalDirectory(path string) (string, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || strings.ContainsAny(path, "\x00\r\n") {
		return "", ErrInvalid
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", ErrInvalid
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.IsDir() {
		return "", ErrInvalid
	}
	return resolved, nil
}

func contained(root, child string) bool {
	rel, err := filepath.Rel(root, child)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

func InspectSource(ctx context.Context, executable, selectedRoot string, allowedRoots []string, limits Limits) (Source, error) {
	g, err := newGit(executable, limits)
	if err != nil {
		return Source{}, err
	}
	root, err := canonicalDirectory(selectedRoot)
	if err != nil {
		return Source{}, err
	}
	allowed := false
	for _, path := range allowedRoots {
		parent, err := canonicalDirectory(path)
		if err != nil {
			return Source{}, err
		}
		if contained(parent, root) {
			allowed = true
		}
	}
	if !allowed {
		return Source{}, ErrInvalid
	}
	top, err := g.text(ctx, root, "rev-parse", "--show-toplevel")
	if err != nil {
		return Source{}, err
	}
	top, err = canonicalDirectory(filepath.Clean(top))
	if err != nil || top != root {
		return Source{}, ErrInvalid
	}
	gitDir, err := g.text(ctx, root, "rev-parse", "--absolute-git-dir")
	if err != nil {
		return Source{}, err
	}
	common, err := g.text(ctx, root, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return Source{}, err
	}
	format, err := g.text(ctx, root, "rev-parse", "--show-object-format")
	if err != nil || (format != "sha1" && format != "sha256") {
		return Source{}, ErrInvalid
	}
	source := Source{Root: root, GitDirectory: filepath.Clean(gitDir), CommonDirectory: filepath.Clean(common), ObjectFormat: format}
	// Metadata for linked worktrees may be outside their working directory but
	// must still be inside an explicitly owner-approved root.
	for _, path := range []string{source.GitDirectory, source.CommonDirectory} {
		resolved, err := canonicalDirectory(path)
		if err != nil || resolved != path {
			return Source{}, ErrInvalid
		}
		metadataAllowed := false
		for _, ownerRoot := range allowedRoots {
			parent, _ := canonicalDirectory(ownerRoot)
			if contained(parent, path) {
				metadataAllowed = true
			}
		}
		if !metadataAllowed {
			return Source{}, ErrInvalid
		}
	}
	source.RootIdentity, err = directoryIdentity(source.Root)
	if err != nil {
		return Source{}, err
	}
	source.GitIdentity, err = directoryIdentity(source.GitDirectory)
	if err != nil {
		return Source{}, err
	}
	source.CommonIdentity, err = directoryIdentity(source.CommonDirectory)
	if err != nil {
		return Source{}, err
	}
	if err := g.checkSource(ctx, source); err != nil {
		return Source{}, err
	}
	return source, nil
}

func (s Source) check() error {
	for _, pin := range []struct{ path, identity string }{{s.Root, s.RootIdentity}, {s.GitDirectory, s.GitIdentity}, {s.CommonDirectory, s.CommonIdentity}} {
		actual, err := directoryIdentity(pin.path)
		if err != nil || pin.identity == "" || actual != pin.identity {
			return ErrChanged
		}
	}
	return nil
}

func (g gitRunner) checkSource(ctx context.Context, source Source) error {
	if err := source.check(); err != nil {
		return err
	}
	for _, check := range []struct{ arg, expected string }{{"--absolute-git-dir", source.GitDirectory}, {"--git-common-dir", source.CommonDirectory}, {"--show-object-format", source.ObjectFormat}} {
		actual, err := g.text(ctx, source.Root, "rev-parse", "--path-format=absolute", check.arg)
		if check.arg != "--show-object-format" {
			actual = filepath.Clean(actual)
		}
		if err != nil || actual != check.expected {
			return ErrChanged
		}
	}
	for _, name := range []string{"objects/info/alternates", "objects/info/http-alternates"} {
		if _, err := os.Lstat(filepath.Join(source.CommonDirectory, name)); !errors.Is(err, os.ErrNotExist) {
			return ErrInvalid
		}
	}
	return nil
}

var objectID = regexp.MustCompile(`^(?:[0-9a-f]{40}|[0-9a-f]{64})$`)

func validObject(id, format string) bool {
	return objectID.MatchString(id) && ((format == "sha1" && len(id) == 40) || (format == "sha256" && len(id) == 64))
}

func digest(value any) string {
	encoded, _ := json.Marshal(value)
	hash := sha256.Sum256(encoded)
	return hex.EncodeToString(hash[:])
}

type treeEntry struct{ mode, kind, id, path string }

// Restrict portable path spelling before checkout; Git metadata aliases,
// case-colliding entries and Windows device/alternate-stream paths must not turn
// the same pinned tree into different physical workspaces on different hosts.
func portablePath(path string) bool {
	if !utf8.ValidString(path) || path == "" || len(path) > 4096 || strings.ContainsAny(path, "\\:*?\"<>|") {
		return false
	}
	for _, r := range path {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return false
		}
	}
	for _, part := range strings.Split(path, "/") {
		low := strings.ToLower(part)
		if part == "" || part == "." || part == ".." || low == ".git" || strings.HasPrefix(low, "git~") || strings.HasPrefix(low, ".git~") ||
			strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") {
			return false
		}
		name := strings.SplitN(strings.ToUpper(part), ".", 2)[0]
		if name == "CON" || name == "PRN" || name == "AUX" || name == "NUL" ||
			(len(name) == 4 && (strings.HasPrefix(name, "COM") || strings.HasPrefix(name, "LPT")) && name[3] >= '0' && name[3] <= '9') {
			return false
		}
	}
	return true
}

func (g gitRunner) entries(ctx context.Context, directory, tree, format string) ([]treeEntry, error) {
	raw, err := g.run(ctx, directory, nil, 16<<20, "ls-tree", "-r", "-t", "-z", "--full-tree", tree)
	if err != nil {
		return nil, err
	}
	var entries []treeEntry
	seen := map[string]bool{}
	for _, record := range bytes.Split(raw, []byte{0}) {
		if len(record) == 0 {
			continue
		}
		metadata, path, ok := strings.Cut(string(record), "\t")
		fields := strings.Fields(metadata)
		if !ok || len(fields) != 3 || !portablePath(path) || !validObject(fields[2], format) {
			return nil, ErrInvalid
		}
		key := strings.ToLower(norm.NFC.String(path))
		if seen[key] {
			return nil, ErrInvalid
		}
		seen[key] = true
		if !(fields[0] == "040000" && fields[1] == "tree") && !(fields[0] == "160000" && fields[1] == "commit") &&
			!((fields[0] == "100644" || fields[0] == "100755" || fields[0] == "120000") && fields[1] == "blob") {
			return nil, ErrInvalid
		}
		entries = append(entries, treeEntry{fields[0], fields[1], fields[2], path})
		if len(entries) > g.limits.Entries {
			return nil, ErrLimit
		}
	}
	return entries, nil
}

// objectList contains exactly one commit and its tree/blob closure, not history,
// other branches, replacement objects, or submodule repositories.
func (g gitRunner) objectList(ctx context.Context, source Source, base string) (string, string, error) {
	if err := g.checkSource(ctx, source); err != nil {
		return "", "", err
	}
	if !validObject(base, source.ObjectFormat) {
		return "", "", ErrInvalid
	}
	kind, err := g.text(ctx, source.Root, "cat-file", "-t", base)
	if err != nil || kind != "commit" {
		return "", "", ErrInvalid
	}
	commit, err := g.run(ctx, source.Root, nil, 1<<20, "cat-file", "commit", base)
	if err != nil {
		return "", "", err
	}
	first, _, _ := strings.Cut(string(commit), "\n")
	tree := strings.TrimPrefix(first, "tree ")
	if !strings.HasPrefix(first, "tree ") || !validObject(tree, source.ObjectFormat) {
		return "", "", ErrInvalid
	}
	entries, err := g.entries(ctx, source.Root, tree, source.ObjectFormat)
	if err != nil {
		return "", "", err
	}
	types := map[string]string{base: "commit", tree: "tree"}
	for _, entry := range entries {
		if entry.kind != "commit" {
			types[entry.id] = entry.kind
		}
	}
	ids := make([]string, 0, len(types))
	for id := range types {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	list := strings.Join(ids, "\n") + "\n"
	raw, err := g.run(ctx, source.Root, strings.NewReader(list), 16<<20, "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)")
	if err != nil {
		return "", "", err
	}
	rows := strings.Split(strings.TrimSuffix(string(raw), "\n"), "\n")
	if len(rows) != len(ids) {
		return "", "", ErrInvalid
	}
	sizes := map[string]int64{}
	var unique int64
	for i, row := range rows {
		fields := strings.Fields(row)
		if len(fields) != 3 || fields[0] != ids[i] || fields[1] != types[ids[i]] {
			return "", "", ErrInvalid
		}
		size, err := strconv.ParseInt(fields[2], 10, 64)
		if err != nil || size < 0 || size > g.limits.SnapshotBytes-unique {
			return "", "", ErrLimit
		}
		sizes[ids[i]] = size
		unique += size
	}
	var checkout int64
	for _, entry := range entries {
		if entry.kind == "blob" {
			if sizes[entry.id] > g.limits.SnapshotBytes-checkout {
				return "", "", ErrLimit
			}
			checkout += sizes[entry.id]
		}
	}
	return list, tree, nil
}

func (g gitRunner) importSnapshot(ctx context.Context, source Source, base, destination string) (string, error) {
	list, tree, err := g.objectList(ctx, source, base)
	if err != nil {
		return "", err
	}
	pack, err := g.run(ctx, source.Root, strings.NewReader(list), g.limits.SnapshotBytes+(16<<20),
		"pack-objects", "--stdout", "--window=0", "--no-reuse-delta", "--no-reuse-object")
	if err != nil {
		return "", err
	}
	if err = source.check(); err != nil {
		return "", err
	}
	if _, err = g.run(ctx, destination, nil, 16<<10, "init", "--bare", "--template=", "--object-format="+source.ObjectFormat, "."); err != nil {
		return "", err
	}
	if err = os.Mkdir(filepath.Join(destination, "info"), 0o700); err != nil {
		return "", err
	}
	if err = writeExclusive(filepath.Join(destination, "info", "attributes"), []byte(exactCheckoutAttributes)); err != nil {
		return "", err
	}
	if _, err = g.run(ctx, destination, bytes.NewReader(pack), 16<<10, "index-pack", "--stdin"); err != nil {
		return "", err
	}
	// Deliberately omit ancestor history; retain the exact original commit ID and
	// declare that commit a shallow boundary in this independent owned store.
	if err = writeExclusive(filepath.Join(destination, "shallow"), []byte(base+"\n")); err != nil {
		return "", err
	}
	actual, err := g.text(ctx, destination, "rev-parse", base+"^{tree}")
	if err != nil || actual != tree {
		return "", fmt.Errorf("imported repository snapshot did not match: %w", ErrChanged)
	}
	return tree, nil
}

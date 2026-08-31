package repository

import (
	"bytes"
	"context"
	"strings"
)

// Index contents are not file-content evidence. Inspect them only to reject
// unresolved conflicts/gitlink changes and, on Windows, preserve Git's explicit
// executable mode where the filesystem has no POSIX executable bit.
func (g gitRunner) captureIndex(ctx context.Context, ready PreparedWorkspace, head, format string, baseline []treeEntry) (map[string]string, string, error) {
	raw, err := g.run(ctx, ready.Path, nil, 16<<20, "ls-files", "--stage", "-z")
	if err != nil {
		return nil, "", err
	}
	indexLinks := map[string]string{}
	baseLinks := map[string]string{}
	modes := map[string]string{}
	for _, entry := range baseline {
		if entry.kind == "commit" {
			baseLinks[entry.path] = entry.id
		}
	}
	for _, row := range bytes.Split(raw, []byte{0}) {
		if len(row) == 0 {
			continue
		}
		metadata, path, ok := strings.Cut(string(row), "\t")
		fields := strings.Fields(metadata)
		if !ok || !portablePath(path) || len(fields) != 3 || fields[2] != "0" || !validObject(fields[1], format) || modes[path] != "" {
			return nil, "", ErrChanged
		}
		if fields[0] != "100644" && fields[0] != "100755" && fields[0] != "120000" && fields[0] != "160000" {
			return nil, "", ErrChanged
		}
		modes[path] = fields[0]
		if fields[0] == "160000" {
			indexLinks[path] = fields[1]
		}
	}
	if digest(baseLinks) != digest(indexLinks) {
		return nil, "", ErrSpecialOutput
	}
	current, err := g.entries(ctx, ready.GitDirectory, head, format)
	if err != nil {
		return nil, "", err
	}
	headLinks := map[string]string{}
	for _, entry := range current {
		if entry.kind == "commit" {
			headLinks[entry.path] = entry.id
		}
	}
	if digest(baseLinks) != digest(headLinks) {
		return nil, "", ErrSpecialOutput
	}
	return modes, digest(string(raw)), nil
}

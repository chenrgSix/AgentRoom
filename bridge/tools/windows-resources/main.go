// windows-resources deterministically derives the Windows product icon from
// the website's authoritative SVG. It never adds a manifest or version resource.
package main

import (
	"bytes"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

const sourcePath = "site/public/mark.svg"

type artifact struct {
	path string
	data []byte
}

func main() {
	root := flag.String("root", "", "repository root (absolute or relative to the working directory)")
	mode := flag.String("mode", "check", "generate, check, or verify")
	exe := flag.String("exe", "", "PE executable to inspect in verify mode")
	flag.Parse()
	if err := run(*root, *mode, *exe); err != nil {
		fmt.Fprintln(os.Stderr, "Windows icon:", err)
		os.Exit(1)
	}
	fmt.Printf("Windows icon %s passed\n", *mode)
}

func run(root, mode, exe string) error {
	if root == "" {
		return errors.New("-root is required")
	}
	if mode != "generate" && mode != "check" && mode != "verify" {
		return errors.New("-mode must be generate, check, or verify")
	}
	if (mode == "verify") != (exe != "") {
		return errors.New("-exe is required only for verify mode")
	}
	var err error
	root, err = filepath.Abs(root)
	if err != nil {
		return errors.New("resolve repository root")
	}
	svg, err := readBounded(filepath.Join(root, filepath.FromSlash(sourcePath)), maxSVGBytes)
	if err != nil {
		return fmt.Errorf("read %s: %w", sourcePath, err)
	}
	artifacts, resources, err := generateArtifacts(svg)
	if err != nil {
		return err
	}
	if mode == "verify" {
		return verifyExecutable(exe, resources)
	}
	for _, output := range artifacts {
		path := filepath.Join(root, filepath.FromSlash(output.path))
		if mode == "check" {
			actual, err := readBounded(path, 4<<20)
			if err != nil || !bytes.Equal(actual, output.data) {
				return fmt.Errorf("%s is missing or stale; run -mode generate and review all generated resources", output.path)
			}
		} else if err := writeArtifact(root, output); err != nil {
			return err
		}
	}
	return nil
}

func readBounded(path string, limit int64) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > limit {
		return nil, errors.New("expected a bounded regular file, not a symlink")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if len(data) > int(limit) {
		return nil, errors.New("file exceeds its size limit")
	}
	return data, err
}

func writeArtifact(root string, output artifact) error {
	// Fixed relative output paths are the entire write authority. Reject
	// symlinks at every traversed output component instead of following them.
	path := root
	relative := filepath.FromSlash(output.path)
	directory := filepath.Dir(relative)
	for _, component := range splitPath(directory) {
		path = filepath.Join(path, component)
		info, err := os.Lstat(path)
		if errors.Is(err, os.ErrNotExist) {
			if err := os.Mkdir(path, 0o755); err != nil {
				return err
			}
		} else if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("generated resource directory must not be a symlink")
		}
	}
	destination := filepath.Join(root, relative)
	if info, err := os.Lstat(destination); err == nil && !info.Mode().IsRegular() {
		return errors.New("generated resource destination must be a regular file")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	temporary, err := os.CreateTemp(path, ".windows-icon-*")
	if err != nil {
		return err
	}
	defer os.Remove(temporary.Name())
	if _, err := temporary.Write(output.data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Chmod(0o644); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporary.Name(), destination)
}

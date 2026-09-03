package releaseimage

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCentralRuntimeImageIncludesEveryContractsRuntimeExport(t *testing.T) {
	workingDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	repositoryRoot := filepath.Clean(filepath.Join(workingDirectory, "..", "..", "..", ".."))
	packageRoot := filepath.Join(repositoryRoot, "packages", "contracts")

	packageBytes, err := os.ReadFile(filepath.Join(packageRoot, "package.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Exports map[string]json.RawMessage `json:"exports"`
	}
	if err := json.Unmarshal(packageBytes, &manifest); err != nil {
		t.Fatal(err)
	}

	dockerfileBytes, err := os.ReadFile(filepath.Join(repositoryRoot, "Dockerfile"))
	if err != nil {
		t.Fatal(err)
	}
	runtimeStage := strings.SplitN(string(dockerfileBytes), "FROM node:22-bookworm-slim", 3)
	if len(runtimeStage) != 3 {
		t.Fatal("Central Dockerfile must contain distinct build and runtime stages")
	}

	for exportName, rawExport := range manifest.Exports {
		var conditional struct {
			Default string `json:"default"`
		}
		if err := json.Unmarshal(rawExport, &conditional); err != nil || conditional.Default == "" {
			continue
		}
		target := strings.TrimPrefix(filepath.ToSlash(conditional.Default), "./")
		if filepath.Ext(target) != ".mjs" {
			continue
		}
		if _, err := os.Stat(filepath.Join(packageRoot, filepath.FromSlash(target))); err != nil {
			t.Fatalf("Contracts runtime export %q target %q is unavailable: %v", exportName, target, err)
		}
		if !runtimeStageCopiesContractsTarget(runtimeStage[2], target) {
			t.Errorf("Central runtime image omits Contracts runtime export %q target %q", exportName, target)
		}
	}
}

func runtimeStageCopiesContractsTarget(runtimeStage string, target string) bool {
	target = strings.TrimPrefix(filepath.ToSlash(target), "./")
	for _, line := range strings.Split(runtimeStage, "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) < 3 || fields[0] != "COPY" {
			continue
		}
		for _, field := range fields[1 : len(fields)-1] {
			if strings.HasPrefix(field, "--") {
				continue
			}
			const packagePrefix = "/app/packages/contracts/"
			if !strings.HasPrefix(field, packagePrefix) {
				continue
			}
			copied := strings.TrimSuffix(strings.TrimPrefix(field, packagePrefix), "/")
			if target == copied || strings.HasPrefix(target, copied+"/") {
				return true
			}
		}
	}
	return false
}

package console

import (
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"

	"agentroom.dev/bridge/internal/launchable"
)

type RuntimeDiscovery struct {
	Path   string `json:"path,omitempty"`
	Source string `json:"source,omitempty"`
}

type executableCandidate struct{ path, source string }

func discoverRuntime(name string) RuntimeDiscovery {
	homeDirectory, _ := os.UserHomeDir()
	return discoverRuntimeFrom(name, runtime.GOOS, runtimeCandidates(name, runtime.GOOS, homeDirectory, os.Getenv), exec.LookPath)
}

func discoverRuntimeFrom(name, platform string, candidates []executableCandidate, lookPath func(string) (string, error)) RuntimeDiscovery {
	if name != "codex" && name != "pi" {
		return RuntimeDiscovery{}
	}
	if path, err := lookPath(name); err == nil && filepath.IsAbs(path) && launchable.File(path, platform) {
		return RuntimeDiscovery{Path: path, Source: "PATH"}
	}
	for _, candidate := range candidates {
		if filepath.IsAbs(candidate.path) && launchable.File(candidate.path, platform) {
			return RuntimeDiscovery{Path: candidate.path, Source: candidate.source}
		}
	}
	return RuntimeDiscovery{}
}

func runtimeCandidates(name, platform, homeDirectory string, getenv func(string) string) []executableCandidate {
	var result []executableCandidate
	addBin := func(directory, source string) {
		if !filepath.IsAbs(directory) {
			return
		}
		for _, filename := range launchable.Filenames(name, platform) {
			result = append(result, executableCandidate{filepath.Join(directory, filename), source})
		}
	}
	if platform == "darwin" && name == "codex" {
		roots := []string{"/Applications"}
		if filepath.IsAbs(homeDirectory) {
			roots = append(roots, filepath.Join(homeDirectory, "Applications"))
		}
		for _, root := range roots {
			for _, app := range []string{"ChatGPT.app", "Codex.app"} {
				addBin(filepath.Join(root, app, "Contents", "Resources"), "macOS App")
			}
		}
	}
	if platform != "windows" {
		addBin("/opt/homebrew/bin", "Homebrew / system")
		addBin("/usr/local/bin", "Homebrew / system")
	}
	if filepath.IsAbs(homeDirectory) {
		for _, directory := range []string{".local/bin", "bin", ".npm-global/bin", ".volta/bin", ".bun/bin"} {
			addBin(filepath.Join(homeDirectory, directory), "user bin")
		}
	}
	addBin(getenv("NVM_BIN"), "nvm")
	nvmRoot := getenv("NVM_DIR")
	if !filepath.IsAbs(nvmRoot) && filepath.IsAbs(homeDirectory) {
		nvmRoot = filepath.Join(homeDirectory, ".nvm")
	}
	if filepath.IsAbs(nvmRoot) {
		for _, directory := range nvmVersionBins(filepath.Join(nvmRoot, "versions", "node")) {
			addBin(directory, "nvm")
		}
	}
	return result
}

// Read only one known installation directory, at most 128 entries. Never run
// login shells or source user profiles merely to locate an executable.
func nvmVersionBins(root string) []string {
	directory, err := os.Open(root)
	if err != nil {
		return nil
	}
	defer directory.Close()
	entries, _ := directory.ReadDir(128)
	type version struct {
		name  string
		parts [3]int
	}
	versions := make([]version, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), "v") {
			continue
		}
		parts := strings.Split(strings.TrimPrefix(entry.Name(), "v"), ".")
		if len(parts) != 3 {
			continue
		}
		item := version{name: entry.Name()}
		valid := true
		for index, part := range parts {
			value, err := strconv.Atoi(part)
			if err != nil || value < 0 {
				valid = false
				break
			}
			item.parts[index] = value
		}
		if valid {
			versions = append(versions, item)
		}
	}
	sort.Slice(versions, func(i, j int) bool {
		for index := range versions[i].parts {
			if versions[i].parts[index] != versions[j].parts[index] {
				return versions[i].parts[index] > versions[j].parts[index]
			}
		}
		return versions[i].name < versions[j].name
	})
	result := make([]string, 0, len(versions))
	for _, version := range versions {
		result = append(result, filepath.Join(root, version.name, "bin"))
	}
	return result
}

func (s *Service) discoverRuntimes() map[string]RuntimeDiscovery {
	return map[string]RuntimeDiscovery{"codex": s.dependencies.DiscoverRuntime("codex"), "pi": s.dependencies.DiscoverRuntime("pi")}
}

func (s *Service) applyDiscoveryLocked(discovered map[string]RuntimeDiscovery) {
	s.state.RuntimeDiscovery = discovered
	s.state.DetectedCodex = discovered["codex"].Path
	s.state.DetectedPi = discovered["pi"].Path
}

func (s *Service) refreshRuntimeDiscovery(response http.ResponseWriter, _ *http.Request) {
	discovered := s.discoverRuntimes()
	s.mu.Lock()
	s.applyDiscoveryLocked(discovered)
	s.mu.Unlock()
	writeJSON(response, http.StatusOK, discovered)
}

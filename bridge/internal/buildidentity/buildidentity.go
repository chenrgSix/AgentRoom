package buildidentity

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"sync"
)

var sourceCommitPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)
var executableSHA256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Observation binds one running Bridge process to the executable bytes it
// hashed at startup. An empty Observation is the rolling-compatibility shape
// for development and already released Bridges; the two fields are never
// exposed independently.
type Observation struct {
	SourceCommit     string
	ExecutableSHA256 string
}

// Validate enforces the rolling wire boundary: either both build fields are
// absent, or both contain their canonical full hashes.
func (observation Observation) Validate() error {
	if observation == (Observation{}) {
		return nil
	}
	if !sourceCommitPattern.MatchString(observation.SourceCommit) ||
		!executableSHA256Pattern.MatchString(observation.ExecutableSHA256) {
		return fmt.Errorf("Bridge build observation must contain one exact source commit and executable SHA-256")
	}
	return nil
}

var processObservation struct {
	sync.RWMutex
	value Observation
}

// Initialize hashes the executable at process startup and publishes the pair
// used by subsequent authenticated hello messages. Release builds inject one
// exact source commit; development builds intentionally retain the legacy
// absent-pair wire shape.
func Initialize(sourceCommit string) error {
	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve Bridge executable: %w", err)
	}
	observation, err := resolve(sourceCommit, executable)
	if err != nil {
		return err
	}
	processObservation.Lock()
	processObservation.value = observation
	processObservation.Unlock()
	return nil
}

// Current returns a copy of the startup observation. Calling it before
// Initialize is equivalent to a rolling-compatible legacy development build.
func Current() Observation {
	processObservation.RLock()
	defer processObservation.RUnlock()
	return processObservation.value
}

func resolve(sourceCommit, executable string) (Observation, error) {
	digest, err := sha256File(executable)
	if err != nil {
		return Observation{}, fmt.Errorf("hash Bridge executable: %w", err)
	}
	commit := strings.TrimSpace(sourceCommit)
	if commit == "" {
		return Observation{}, nil
	}
	if !sourceCommitPattern.MatchString(commit) {
		return Observation{}, fmt.Errorf("Bridge source commit must be one lowercase 40-character SHA")
	}
	return Observation{SourceCommit: commit, ExecutableSHA256: digest}, nil
}

func sha256File(filename string) (string, error) {
	file, err := os.Open(filename)
	if err != nil {
		return "", err
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

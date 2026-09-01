package runtime

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"regexp"
)

var (
	ErrGovernedProcessInvalid = errors.New("governed Runtime process identity is invalid")
	governedProcessRunID      = regexp.MustCompile(`^run_[A-Za-z0-9_-]{8,128}$`)
	governedProcessDigest     = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

// GovernedProcessIdentity binds the OS process proof to the already durable
// admission/start boundary. It contains no command, environment or local path.
type GovernedProcessIdentity struct {
	RunID           string `json:"runId"`
	AdmissionDigest string `json:"admissionDigest"`
	StartDigest     string `json:"startDigest"`
}

type GovernedProcessObservation struct {
	PID              int    `json:"pid"`
	PlatformIdentity string `json:"platformIdentity"`
}

// GovernedProcessLease is prepared durably before any child exists. Started is
// called while the child cannot execute the configured Runtime. Finished is
// called only after the complete owned process tree has been terminated.
type GovernedProcessLease interface {
	InheritedLockFile() *os.File
	Started(GovernedProcessObservation) error
	Finished(GovernedProcessObservation) error
	Abandon() error
}

type GovernedProcessTracker interface {
	PrepareProcess(GovernedProcessIdentity) (GovernedProcessLease, error)
}

// runtimeCommand owns the platform-specific process lifecycle. On Unix the
// implementation is the exec.Cmd itself; Windows uses a Job Object wrapper so
// cancellation and normal teardown include every descendant process.
type runtimeCommand interface {
	Start() error
	Wait() error
	Run() error
}

func newRuntimeCommand(ctx context.Context, args []string, tracker GovernedProcessTracker,
	identity GovernedProcessIdentity) (*exec.Cmd, runtimeCommand, error) {
	if len(args) == 0 {
		return nil, nil, ErrGovernedProcessInvalid
	}
	if tracker == nil {
		if identity != (GovernedProcessIdentity{}) {
			return nil, nil, ErrGovernedProcessInvalid
		}
		command := exec.CommandContext(ctx, args[0], args[1:]...)
		return command, configureRuntimeCommand(command), nil
	}
	if !validGovernedProcessIdentity(identity) {
		return nil, nil, ErrGovernedProcessInvalid
	}
	return configureGovernedRuntimeCommand(ctx, args, tracker, identity)
}

func validGovernedProcessIdentity(identity GovernedProcessIdentity) bool {
	return governedProcessRunID.MatchString(identity.RunID) &&
		governedProcessDigest.MatchString(identity.AdmissionDigest) &&
		governedProcessDigest.MatchString(identity.StartDigest)
}

func ValidateGovernedProcessIdentity(identity GovernedProcessIdentity) error {
	if !validGovernedProcessIdentity(identity) {
		return ErrGovernedProcessInvalid
	}
	return nil
}

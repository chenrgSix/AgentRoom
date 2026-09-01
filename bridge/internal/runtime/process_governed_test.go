package runtime

import (
	"os"
	"sync"
)

type governedProcessTrackerStub struct {
	lease    *governedProcessLeaseStub
	prepared int
	identity GovernedProcessIdentity
}

func (s *governedProcessTrackerStub) PrepareProcess(identity GovernedProcessIdentity) (GovernedProcessLease, error) {
	s.prepared++
	s.identity = identity
	return s.lease, nil
}

type governedProcessLeaseStub struct {
	mu             sync.Mutex
	lockFile       *os.File
	started        int
	finished       int
	abandoned      int
	startErr       error
	startedCheck   func() error
	observation    GovernedProcessObservation
	finishedRecord GovernedProcessObservation
}

func (s *governedProcessLeaseStub) InheritedLockFile() *os.File {
	return s.lockFile
}

func (s *governedProcessLeaseStub) Started(observation GovernedProcessObservation) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.started++
	s.observation = observation
	if s.startedCheck != nil {
		if err := s.startedCheck(); err != nil {
			return err
		}
	}
	if s.lockFile != nil {
		_ = s.lockFile.Close()
	}
	return s.startErr
}

func (s *governedProcessLeaseStub) Finished(observation GovernedProcessObservation) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.finished++
	s.finishedRecord = observation
	if s.lockFile != nil {
		_ = s.lockFile.Close()
	}
	return nil
}

func (s *governedProcessLeaseStub) Abandon() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.abandoned++
	if s.lockFile != nil {
		_ = s.lockFile.Close()
	}
	return nil
}

func governedProcessIdentityFixture() GovernedProcessIdentity {
	return GovernedProcessIdentity{RunID: "run_governedprocess01",
		AdmissionDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		StartDigest:     "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
}

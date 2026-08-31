package main

import (
	"context"
	"fmt"
	"path/filepath"
	"time"

	"convenewire.dev/bridge/internal/admission"
	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/ownership"
	"convenewire.dev/bridge/internal/pairing"
	"convenewire.dev/bridge/internal/repository"
)

// localOwnerSession holds the one existing Bridge process-owner fence while a
// bounded administration command opens one or more local authority stores.
type localOwnerSession struct {
	Config     config.Config
	Credential pairing.Credential
	DataDir    string
	Context    context.Context
	owner      *ownership.Lock
}

func openLocalOwner(configPath string, issuing bool, clock func() time.Time) (*localOwnerSession, error) {
	resolved := configPath
	if resolved == "" {
		resolved = config.DefaultPath()
	}
	loaded, err := config.Load(resolved)
	if err != nil {
		return nil, err
	}
	owner, err := ownership.Acquire(loaded.DataDir)
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*localOwnerSession, error) {
		_ = owner.Release()
		return nil, err
	}
	credential, err := pairing.Load(loaded.DataDir)
	if err != nil {
		return fail(err)
	}
	if err := pairing.ValidateCredentialOrigin(loaded.ServerURL, credential); err != nil {
		return fail(err)
	}
	if credential.ServerURL != loaded.ServerURL {
		return fail(fmt.Errorf("local authority requires the exact paired Central"))
	}
	if issuing && credential.ExpiresAt != nil {
		expires, err := time.Parse(time.RFC3339Nano, *credential.ExpiresAt)
		if err != nil || !clock().Before(expires) {
			return fail(fmt.Errorf("local authority requires a current local Device credential"))
		}
	}
	dataDir, err := filepath.EvalSymlinks(loaded.DataDir)
	if err != nil {
		return fail(err)
	}
	return &localOwnerSession{Config: loaded, Credential: credential, DataDir: dataDir,
		Context: ownership.WithOwner(context.Background(), owner), owner: owner}, nil
}

func (s *localOwnerSession) Close() error {
	if s == nil || s.owner == nil {
		return nil
	}
	return s.owner.Release()
}

func (s *localOwnerSession) RepositoryOwner() repository.BindingOwner {
	return repository.BindingOwner{ServerURL: s.Credential.ServerURL, TeamID: s.Credential.TeamID,
		DeviceID: s.Credential.DeviceID, OwnerMemberID: s.Credential.OwnerMemberID}
}

func (s *localOwnerSession) ProfileOwner() admission.Owner {
	return admission.Owner{ServerURL: s.Credential.ServerURL, TeamID: s.Credential.TeamID,
		DeviceID: s.Credential.DeviceID, OwnerMemberID: s.Credential.OwnerMemberID}
}

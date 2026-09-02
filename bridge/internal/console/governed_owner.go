package console

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"convenewire.dev/bridge/internal/admission"
	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/ownership"
	"convenewire.dev/bridge/internal/pairing"
	"convenewire.dev/bridge/internal/repository"
	"convenewire.dev/bridge/internal/verification"
	execution "convenewire.dev/contracts/generated/go/execution"
)

type GovernedGrantRevocationInput struct {
	ExpectedRevision int64  `json:"expectedRevision"`
	ExpectedDigest   string `json:"expectedDigest"`
	Confirm          bool   `json:"confirm"`
}

type GovernedGrantView struct {
	GrantID    string                  `json:"grantId"`
	Revision   int64                   `json:"revision"`
	Digest     string                  `json:"digest"`
	AgentID    string                  `json:"agentId"`
	TaskID     string                  `json:"taskId"`
	NodeKey    string                  `json:"nodeKey"`
	Operations []execution.KindElement `json:"operations"`
	ExpiresAt  string                  `json:"expiresAt"`
	RevokedAt  *string                 `json:"revokedAt"`
}

type GovernedOwnerState struct {
	Bindings             []repository.BindingView       `json:"bindings"`
	Grants               []GovernedGrantView            `json:"grants"`
	RuntimeProfiles      []admission.RuntimeProfileView `json:"runtimeProfiles"`
	VerificationProfiles []verification.ProfileView     `json:"verificationProfiles"`
	CleanupGrants        []repository.CleanupGrantView  `json:"cleanupGrants"`
}

func inspectGovernedOwnerState(ctx context.Context, cfg config.Config,
	credential pairing.Credential) (GovernedOwnerState, error) {
	state := GovernedOwnerState{
		Bindings: []repository.BindingView{}, Grants: []GovernedGrantView{},
		RuntimeProfiles:      []admission.RuntimeProfileView{},
		VerificationProfiles: []verification.ProfileView{},
		CleanupGrants:        []repository.CleanupGrantView{},
	}
	stores, err := openGovernedOwnerStores(ctx, cfg, credential)
	if err != nil {
		return state, err
	}
	defer stores.close()
	if state.Bindings, err = stores.bindings.List(); err != nil {
		return state, err
	}
	grants, err := stores.bindings.ListTaskGrants()
	if err != nil {
		return state, err
	}
	for _, grant := range grants {
		state.Grants = append(state.Grants, governedGrantView(grant))
	}
	if state.RuntimeProfiles, err = stores.runtimeProfiles.List(); err != nil {
		return state, err
	}
	if state.VerificationProfiles, err = stores.verificationProfiles.List(); err != nil {
		return state, err
	}
	if state.CleanupGrants, err = stores.bindings.ListCleanupGrants(); err != nil {
		return state, err
	}
	return state, nil
}

func revokeGovernedTaskGrant(ctx context.Context, cfg config.Config, credential pairing.Credential,
	grantID string, input GovernedGrantRevocationInput, now time.Time) (GovernedGrantView, error) {
	if !input.Confirm || grantID == "" || input.ExpectedRevision != 1 || strings.TrimSpace(input.ExpectedDigest) == "" {
		return GovernedGrantView{}, repository.ErrInvalid
	}
	stores, err := openGovernedOwnerStores(ctx, cfg, credential)
	if err != nil {
		return GovernedGrantView{}, err
	}
	defer stores.close()
	revoked, err := stores.bindings.RevokeTaskGrant(grantID, input.ExpectedRevision,
		input.ExpectedDigest, now)
	if err != nil {
		return GovernedGrantView{}, err
	}
	return governedGrantView(revoked), nil
}

type governedOwnerStores struct {
	bindings             *repository.BindingStore
	runtimeProfiles      *admission.ProfileStore
	verificationProfiles *verification.ProfileStore
}

func openGovernedOwnerStores(ctx context.Context, cfg config.Config,
	credential pairing.Credential) (*governedOwnerStores, error) {
	if ctx == nil || strings.TrimSpace(credential.Token) == "" || credential.ServerURL != cfg.ServerURL {
		return nil, repository.ErrInvalid
	}
	owner := repository.BindingOwner{ServerURL: credential.ServerURL, TeamID: credential.TeamID,
		DeviceID: credential.DeviceID, OwnerMemberID: credential.OwnerMemberID}
	stores := &governedOwnerStores{}
	var err error
	stores.bindings, err = repository.OpenBindingStore(ctx, cfg.DataDir, owner, "", repository.Limits{})
	if err != nil {
		return nil, err
	}
	fail := func(cause error) (*governedOwnerStores, error) {
		return nil, errors.Join(cause, stores.close())
	}
	stores.runtimeProfiles, err = admission.OpenProfileStore(ctx, cfg.DataDir, admission.Owner{
		ServerURL: owner.ServerURL, TeamID: owner.TeamID, DeviceID: owner.DeviceID,
		OwnerMemberID: owner.OwnerMemberID,
	})
	if err != nil {
		return fail(err)
	}
	stores.verificationProfiles, err = verification.OpenProfileStore(cfg.DataDir, verification.Owner{
		ServerURL: owner.ServerURL, TeamID: owner.TeamID, DeviceID: owner.DeviceID,
		OwnerMemberID: owner.OwnerMemberID,
	})
	if err != nil {
		return fail(err)
	}
	return stores, nil
}

func (s *governedOwnerStores) close() error {
	if s == nil {
		return nil
	}
	var result error
	if s.verificationProfiles != nil {
		result = errors.Join(result, s.verificationProfiles.Close())
	}
	if s.runtimeProfiles != nil {
		result = errors.Join(result, s.runtimeProfiles.Close())
	}
	if s.bindings != nil {
		result = errors.Join(result, s.bindings.Close())
	}
	return result
}

func governedGrantView(view repository.TaskGrantView) GovernedGrantView {
	return GovernedGrantView{GrantID: view.Spec.GrantID, Revision: view.Summary.Grant.Revision,
		Digest: view.Summary.Grant.Digest, AgentID: view.Spec.AgentID, TaskID: view.Spec.TaskID,
		NodeKey: view.Spec.NodeKey, Operations: slices.Clone(view.Spec.Operations),
		ExpiresAt: view.Spec.ExpiresAt, RevokedAt: view.Summary.RevokedAt}
}

func cloneGovernedOwnerState(state GovernedOwnerState) GovernedOwnerState {
	cloned := state
	cloned.Bindings = slices.Clone(state.Bindings)
	cloned.Grants = slices.Clone(state.Grants)
	for index := range cloned.Grants {
		cloned.Grants[index].Operations = slices.Clone(state.Grants[index].Operations)
	}
	cloned.RuntimeProfiles = slices.Clone(state.RuntimeProfiles)
	cloned.VerificationProfiles = slices.Clone(state.VerificationProfiles)
	for index := range cloned.VerificationProfiles {
		cloned.VerificationProfiles[index].EnvironmentNames =
			slices.Clone(state.VerificationProfiles[index].EnvironmentNames)
	}
	cloned.CleanupGrants = slices.Clone(state.CleanupGrants)
	return cloned
}

func (s *Service) governedOwnerContext(allowMutation bool) (context.Context, config.Config, pairing.Credential, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || (!allowMutation && s.governedMutation) || s.configuration == nil ||
		s.credential == nil || s.owner == nil {
		return nil, config.Config{}, pairing.Credential{}, fmt.Errorf("Bridge must be configured and paired")
	}
	return ownership.WithOwner(context.Background(), s.owner), *s.configuration, *s.credential, nil
}

func (s *Service) getGovernedOwnerState(response http.ResponseWriter, request *http.Request) {
	s.mu.Lock()
	if (s.bridgeDone != nil || s.state.BridgeRunning) && s.governedStateLoaded {
		state := cloneGovernedOwnerState(s.governedOwnerState)
		s.mu.Unlock()
		writeJSON(response, http.StatusOK, state)
		return
	}
	s.mu.Unlock()
	ownerContext, cfg, credential, err := s.governedOwnerContext(false)
	if err != nil {
		writeError(response, http.StatusConflict, err.Error())
		return
	}
	state, err := s.dependencies.InspectGovernedOwnerState(ownerContext, cfg, credential)
	if err != nil {
		writeError(response, http.StatusConflict, publicError(err))
		return
	}
	writeJSON(response, http.StatusOK, state)
}

func (s *Service) revokeGovernedTaskGrant(response http.ResponseWriter, request *http.Request) {
	var input GovernedGrantRevocationInput
	if err := decodeJSON(request, &input); err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	grantID := request.PathValue("grantId")
	if !input.Confirm || grantID == "" {
		writeError(response, http.StatusBadRequest, "Exact local grant revocation requires confirmation")
		return
	}
	s.mu.Lock()
	if s.governedMutation || s.closed || s.configuration == nil || s.credential == nil || s.owner == nil {
		s.mu.Unlock()
		writeError(response, http.StatusConflict, "Local governed-authority mutation is unavailable")
		return
	}
	s.governedMutation = true
	wasRunning := s.bridgeCancel != nil || s.state.BridgeRunning
	s.mu.Unlock()

	if wasRunning {
		s.StopBridge()
	}
	ownerContext, cfg, credential, contextErr := s.governedOwnerContext(true)
	var revoked GovernedGrantView
	var err error
	if contextErr == nil {
		revoked, err = s.dependencies.RevokeGovernedTaskGrant(ownerContext, cfg, credential,
			grantID, input, time.Now().UTC())
	} else {
		err = contextErr
	}

	s.mu.Lock()
	s.governedMutation = false
	s.mu.Unlock()
	var restartErr error
	if wasRunning {
		_, restartErr = s.StartBridge()
	}
	if err != nil {
		writeError(response, http.StatusConflict, publicError(err))
		return
	}
	if restartErr != nil {
		writeError(response, http.StatusInternalServerError,
			fmt.Sprintf("Grant was revoked, but Bridge restart failed: %s", publicError(restartErr)))
		return
	}
	writeJSON(response, http.StatusOK, revoked)
}

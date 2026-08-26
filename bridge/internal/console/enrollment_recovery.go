package console

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"reflect"

	"agentroom.dev/bridge/internal/config"
	"agentroom.dev/bridge/internal/pairing"
)

// EnrollmentView is local-only; it never contains a Device or claim token.
type EnrollmentView struct {
	Active           bool   `json:"active"`
	Recovery         bool   `json:"recovery"`
	CanRequest       bool   `json:"canRequest"`
	BlockedReason    string `json:"blockedReason,omitempty"`
	CodeExpired      bool   `json:"codeExpired"`
	BackupConfigPath string `json:"backupConfigPath,omitempty"`
}

type ReEnrollmentInput struct {
	ConfirmNewDevice bool   `json:"confirmNewDevice"`
	ExpectedDeviceID string `json:"expectedDeviceId"`
}

func (s *Service) enrollmentBlockedReasonLocked() string {
	switch {
	case s.joinCancel != nil:
		return "已有审批请求，请先取消或等待完成。"
	case s.bridgeCancel != nil:
		return "请先停止 Bridge；重新配对不会自动中断任务。"
	case s.bridgeWorkers > 0:
		return "Bridge 正在停止，请等待连接和任务退出。"
	case s.runtimePreflight || len(s.runtimeTests) > 0:
		return "请等待 Runtime 自检或预检结束。"
	}
	for _, agent := range s.state.Agents {
		if agent.ActiveRuns > 0 {
			return "请等待当前 Team 任务结束。"
		}
	}
	return ""
}

func (s *Service) beginEnrollmentLocked(recovery bool) (context.Context, uint64) {
	ctx, cancel := context.WithCancel(context.Background())
	s.joinCancel = cancel
	s.joinEpoch++
	s.state.Phase = PhaseJoining
	s.state.LastError = ""
	s.state.JoinCode = ""
	s.state.JoinExpiresAt = ""
	s.state.Enrollment.Recovery = recovery
	return ctx, s.joinEpoch
}

func (s *Service) restartEnrollment(response http.ResponseWriter, request *http.Request) {
	var input ReEnrollmentInput
	if err := decodeJSON(request, &input); err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !input.ConfirmNewDevice || input.ExpectedDeviceID == "" {
		writeError(response, http.StatusBadRequest, "Explicit new-Device confirmation and expectedDeviceId are required")
		return
	}
	if s.configuration == nil || s.credential == nil || s.credential.DeviceID != input.ExpectedDeviceID {
		writeError(response, http.StatusConflict, "The paired Device changed; reload before requesting a new code")
		return
	}
	if reason := s.enrollmentBlockedReasonLocked(); reason != "" {
		writeError(response, http.StatusConflict, reason)
		return
	}
	configuration := cloneConfiguration(*s.configuration)
	if err := s.verifyPairingUnchangedLocked(configuration); err != nil {
		writeError(response, http.StatusConflict, err.Error())
		return
	}
	ctx, epoch := s.beginEnrollmentLocked(true)
	go s.enroll(ctx, configuration, true, true, epoch)
	writeJSON(response, http.StatusAccepted, map[string]string{"status": "joining"})
}

func (s *Service) verifyPairingUnchangedLocked(expected config.Config) error {
	current, err := config.Load(s.options.ConfigPath)
	if err != nil || !reflect.DeepEqual(cloneConfiguration(current), cloneConfiguration(expected)) {
		return fmt.Errorf("Local configuration changed; reopen the Console before re-enrollment")
	}
	credential, err := pairing.Load(expected.DataDir)
	if err != nil || s.credential == nil || !reflect.DeepEqual(credential, *s.credential) {
		return fmt.Errorf("Local Device credentials changed; reopen the Console before re-enrollment")
	}
	return nil
}

func (s *Service) installReEnrollmentLocked(previous config.Config, credential pairing.Credential) (config.Config, error) {
	if credential.DeviceID == "" || credential.TeamID == "" || credential.OwnerMemberID == "" ||
		credential.Token == "" || credential.ServerURL != previous.ServerURL || credential.DeviceID == s.credential.DeviceID {
		return previous, fmt.Errorf("Approval did not return a new complete Device identity")
	}
	if err := s.verifyPairingUnchangedLocked(previous); err != nil {
		return previous, err
	}
	directory, err := os.MkdirTemp(filepath.Dir(previous.DataDir), "agentroom-pairing-")
	if err != nil {
		return previous, fmt.Errorf("Unable to stage new pairing; previous pairing is unchanged")
	}
	// Keep the old data in place. A staged but unbound credential is retained
	// for inspection, never mixed into the active identity or silently retried.
	backupPath := filepath.Join(directory, "previous-bridge.json")
	if err := s.dependencies.SaveConfig(backupPath, previous); err != nil {
		return previous, fmt.Errorf("Unable to back up configuration; previous pairing is unchanged")
	}
	s.state.Enrollment.BackupConfigPath = backupPath
	candidate := cloneConfiguration(previous)
	candidate.DataDir = directory
	if err := s.dependencies.SaveCredential(directory, credential); err != nil {
		return previous, fmt.Errorf("Unable to save approved credentials; previous pairing is unchanged")
	}
	priorState := cloneState(s.state)
	if err := s.applyConfigView(candidate); err != nil {
		s.state = priorState
		return previous, fmt.Errorf("Unable to stage Agent identities; previous pairing is unchanged")
	}
	if err := s.verifyPairingUnchangedLocked(previous); err != nil {
		s.state = priorState
		return previous, err
	}
	if err := s.dependencies.ReplaceConfig(s.options.ConfigPath, candidate); err != nil {
		s.state = priorState
		return previous, fmt.Errorf("Unable to activate new pairing; previous pairing is unchanged")
	}
	return candidate, nil
}

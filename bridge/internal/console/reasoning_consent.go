package console

import (
	"agentroom.dev/bridge/internal/config"
	"fmt"
)

func (s *Service) reasoningConsentEditableLocked() bool {
	if s.configuration == nil || s.credential == nil || s.joinCancel != nil ||
		s.bridgeCancel != nil || s.bridgeWorkers > 0 || len(s.runtimeTests) > 0 ||
		s.runtimePreflight {
		return false
	}
	for _, agent := range s.state.Agents {
		if agent.ActiveRuns > 0 {
			return false
		}
	}
	return true
}

func (s *Service) requireReasoningConsentChangeLocked(candidate config.Config) error {
	if candidate.ShareReasoningSummaries != s.configuration.ShareReasoningSummaries &&
		(s.bridgeCancel != nil || s.bridgeWorkers > 0) {
		return fmt.Errorf("请先停止 Bridge 并等待连接和任务退出，再更改思考摘要共享授权。")
	}
	return nil
}

func reasoningConsentForUpdate(previous config.Config, serverURL string, explicit *bool) bool {
	if explicit != nil {
		return *explicit
	}
	return previous.ServerURL == serverURL && previous.ShareReasoningSummaries
}

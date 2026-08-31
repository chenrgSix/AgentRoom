package console

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/pairing"
	pairingcontracts "convenewire.dev/contracts/generated/go/pairing"
)

type clientEntryInput struct {
	RoomID string `json:"roomId,omitempty"`
}

func (s *Service) clientEntrySnapshot() (config.Config, pairing.Credential, uint64, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.configuration == nil || s.credential == nil || s.joinCancel != nil {
		return config.Config{}, pairing.Credential{}, 0, "", fmt.Errorf("请先完成成员与设备配对")
	}
	cfg := cloneConfiguration(*s.configuration)
	credential := *s.credential
	if err := pairing.ValidateCredentialOrigin(cfg.ServerURL, credential); err != nil {
		return cfg, credential, 0, "", fmt.Errorf("当前 Central 与成员授权不匹配，请重新确认配对")
	}
	key, err := pairing.LoadClientAccess(cfg.DataDir, credential)
	if err != nil {
		return cfg, credential, 0, "", fmt.Errorf("此设备尚无成员入口，请让管理员确认实际主人并使用新的成员配对链接")
	}
	return cfg, credential, s.joinEpoch, key, nil
}

func clientEntryRequest(ctx context.Context, cfg config.Config, credential pairing.Credential, key, action, roomID string, target any) error {
	payload := pairingcontracts.ClientEntryRequest{ClientAccessSecret: key}
	if roomID != "" {
		payload.RoomID = &roomID
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("无法准备成员入口请求")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost,
		strings.TrimRight(cfg.ServerURL, "/")+"/api/client-access/"+action, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("成员入口地址无效")
	}
	request.Header.Set("content-type", "application/json")
	request.Header.Set("authorization", "Bearer "+credential.Token)
	client := pairing.HTTPClientForCredential(cfg, credential)
	client.Timeout = 10 * time.Second
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("无法连接中央服务，请检查网络和 HTTPS 信任后重试")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		if response.StatusCode == http.StatusUnauthorized {
			return fmt.Errorf("成员或设备授权已失效，请确认归属后重新配对")
		}
		if response.StatusCode == http.StatusForbidden {
			return fmt.Errorf("当前成员已无权进入此房间，请刷新房间列表")
		}
		return fmt.Errorf("中央服务暂时无法提供成员入口，请稍后重试")
	}
	source, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	if err != nil || len(source) > 65536 {
		return fmt.Errorf("成员入口响应无效")
	}
	decoder := json.NewDecoder(bytes.NewReader(source))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("成员入口响应无效")
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return fmt.Errorf("成员入口响应无效")
	}
	return nil
}

func (s *Service) clientEntryUnchangedLocked(cfg config.Config, credential pairing.Credential, epoch uint64) bool {
	return !s.closed && s.joinCancel == nil && s.joinEpoch == epoch && s.configuration != nil && s.credential != nil &&
		s.configuration.ServerURL == cfg.ServerURL && s.configuration.DataDir == cfg.DataDir &&
		s.credential.DeviceID == credential.DeviceID && s.credential.Token == credential.Token
}

func (s *Service) clientEntryRooms(response http.ResponseWriter, request *http.Request) {
	cfg, credential, epoch, key, err := s.clientEntrySnapshot()
	if err != nil {
		writeError(response, http.StatusConflict, err.Error())
		return
	}
	var identity pairingcontracts.ClientEntryIdentity
	if err := clientEntryRequest(request.Context(), cfg, credential, key, "rooms", "", &identity); err != nil {
		writeError(response, http.StatusBadGateway, err.Error())
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.clientEntryUnchangedLocked(cfg, credential, epoch) || identity.TeamID != credential.TeamID ||
		identity.MemberID != credential.OwnerMemberID || len(identity.Rooms) > 100 {
		writeError(response, http.StatusConflict, "配对身份已变化，请刷新后重试")
		return
	}
	response.Header().Set("cache-control", "no-store")
	writeJSON(response, http.StatusOK, identity)
}

func (s *Service) openClientEntry(response http.ResponseWriter, request *http.Request) {
	var input clientEntryInput
	if err := decodeJSON(request, &input); err != nil {
		writeError(response, http.StatusBadRequest, "成员入口请求无效")
		return
	}
	if input.RoomID != "" && !regexp.MustCompile(`^room_[A-Za-z0-9_-]{8,128}$`).MatchString(input.RoomID) {
		writeError(response, http.StatusBadRequest, "房间身份无效")
		return
	}
	cfg, credential, epoch, key, err := s.clientEntrySnapshot()
	if err != nil {
		writeError(response, http.StatusConflict, err.Error())
		return
	}
	var ticket pairingcontracts.ClientEntryTicket
	if err := clientEntryRequest(request.Context(), cfg, credential, key, "tickets", input.RoomID, &ticket); err != nil {
		writeError(response, http.StatusBadGateway, err.Error())
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.clientEntryUnchangedLocked(cfg, credential, epoch) || !time.Now().Before(ticket.ExpiresAt) ||
		ticket.ExpiresAt.After(time.Now().Add(65*time.Second)) {
		writeError(response, http.StatusConflict, "成员入口已过期或配对已变化，请重试")
		return
	}
	if err := s.dependencies.OpenClientEntry(cfg.ServerURL, ticket.Ticket); err != nil {
		writeError(response, http.StatusBadGateway, "无法打开浏览器，请检查系统默认浏览器后重试")
		return
	}
	response.Header().Set("cache-control", "no-store")
	writeJSON(response, http.StatusOK, map[string]string{"status": "opened"})
}

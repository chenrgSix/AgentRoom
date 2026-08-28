package enrollment

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/pairing"
	contracts "convenewire.dev/contracts/generated/go"
)

type Challenge struct {
	JoinRequestID string
	UserCode      string
	ExpiresAt     time.Time
}

func Join(ctx context.Context, cfg config.Config, show func(Challenge)) (pairing.Credential, error) {
	if err := cfg.Validate(); err != nil {
		return pairing.Credential{}, err
	}
	firstAgent := cfg.Agents[0]
	body, err := json.Marshal(contracts.BridgeJoinRequest{
		DeviceName: cfg.DeviceName,
		AgentName:  firstAgent.Name,
		AgentRole:  firstAgent.Role,
	})
	if err != nil {
		return pairing.Credential{}, err
	}
	endpoint := strings.TrimRight(cfg.ServerURL, "/") + "/api/bridge/join-requests"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return pairing.Credential{}, err
	}
	request.Header.Set("content-type", "application/json")
	if cfg.ServerToken != "" {
		request.Header.Set(config.ServerTokenHeader, cfg.ServerToken)
	}
	response, err := pairing.HTTPClient(cfg).Do(request)
	if err != nil {
		return pairing.Credential{}, fmt.Errorf("create join request: %w", err)
	}
	source, readErr := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	response.Body.Close()
	if readErr != nil {
		return pairing.Credential{}, fmt.Errorf("read join response: %w", readErr)
	}
	if response.StatusCode != http.StatusOK {
		return pairing.Credential{}, fmt.Errorf("join request rejected with status %d", response.StatusCode)
	}
	var joined contracts.BridgeJoinChallenge
	if err := json.Unmarshal(source, &joined); err != nil {
		return pairing.Credential{}, fmt.Errorf("decode join response: %w", err)
	}
	expiresAt := joined.ExpiresAt
	if expiresAt.IsZero() || joined.JoinRequestID == "" || joined.UserCode == "" || joined.PollToken == "" {
		return pairing.Credential{}, fmt.Errorf("join response omitted challenge fields")
	}
	if show != nil {
		show(Challenge{JoinRequestID: joined.JoinRequestID, UserCode: joined.UserCode, ExpiresAt: expiresAt})
	}
	interval := time.Duration(joined.PollIntervalMS) * time.Millisecond
	if interval < 100*time.Millisecond {
		interval = time.Second
	}

	for {
		if !time.Now().Before(expiresAt) {
			return pairing.Credential{}, fmt.Errorf("Bridge join request expired before approval")
		}
		credential, pending, err := claim(ctx, cfg, joined.JoinRequestID, joined.PollToken)
		if err != nil {
			return pairing.Credential{}, err
		}
		if !pending {
			return credential, nil
		}
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return pairing.Credential{}, ctx.Err()
		case <-timer.C:
		}
	}
}

func claim(
	ctx context.Context,
	cfg config.Config,
	joinRequestID string,
	pollToken string,
) (pairing.Credential, bool, error) {
	body, err := json.Marshal(contracts.BridgeJoinClaimRequest{PollToken: pollToken})
	if err != nil {
		return pairing.Credential{}, false, err
	}
	endpoint := strings.TrimRight(cfg.ServerURL, "/") +
		"/api/bridge/join-requests/" + joinRequestID + "/claim"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return pairing.Credential{}, false, err
	}
	request.Header.Set("content-type", "application/json")
	if cfg.ServerToken != "" {
		request.Header.Set(config.ServerTokenHeader, cfg.ServerToken)
	}
	response, err := pairing.HTTPClient(cfg).Do(request)
	if err != nil {
		return pairing.Credential{}, false, fmt.Errorf("claim join request: %w", err)
	}
	defer response.Body.Close()
	source, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return pairing.Credential{}, false, fmt.Errorf("read join claim: %w", err)
	}
	if response.StatusCode == http.StatusAccepted {
		return pairing.Credential{}, true, nil
	}
	if response.StatusCode != http.StatusOK {
		return pairing.Credential{}, false, fmt.Errorf("join claim rejected with status %d", response.StatusCode)
	}
	var claimed contracts.BridgeJoinPaired
	if err := json.Unmarshal(source, &claimed); err != nil {
		return pairing.Credential{}, false, fmt.Errorf("decode join claim: %w", err)
	}
	if claimed.Status != contracts.Paired || claimed.Device.DeviceID == "" || claimed.Credential.Token == "" {
		return pairing.Credential{}, false, fmt.Errorf("join claim omitted identity or credential")
	}
	var expiresAt *string
	if claimed.Credential.ExpiresAt != nil {
		formatted := claimed.Credential.ExpiresAt.Format(time.RFC3339Nano)
		expiresAt = &formatted
	}
	return pairing.Credential{
		ServerURL:     cfg.ServerURL,
		DeviceID:      claimed.Device.DeviceID,
		TeamID:        claimed.Device.TeamID,
		OwnerMemberID: claimed.Device.OwnerMemberID,
		Token:         claimed.Credential.Token,
		ExpiresAt:     expiresAt,
	}, false, nil
}

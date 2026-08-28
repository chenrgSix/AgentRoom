package updatecheck

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestManualCheckComparesVersionsWithoutDownloading(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests++
		if request.Method != http.MethodGet || request.Header.Get("user-agent") != "ConveneWire-Bridge" {
			t.Errorf("unexpected request: %s %#v", request.Method, request.Header)
		}
		response.Header().Set("content-type", "application/json")
		fmt.Fprint(response, "{\"tag_name\":\"v0.3.0\",\"html_url\":\"https://github.com/chenrgSix/AgentRoom/releases/tag/v0.3.0\",\"published_at\":\"2026-08-23T00:00:00Z\"}")
	}))
	defer server.Close()
	checker := &Checker{
		Client: server.Client(), Endpoint: server.URL,
		Now: func() time.Time { return time.Date(2026, 8, 23, 12, 0, 0, 0, time.UTC) },
	}
	if requests != 0 {
		t.Fatal("constructing the checker must not make a request")
	}
	result, err := checker.Check(context.Background(), "v0.2.0")
	if err != nil {
		t.Fatal(err)
	}
	if requests != 1 || !result.UpdateAvailable || !result.CurrentComparable || result.LatestVersion != "v0.3.0" {
		t.Fatalf("unexpected result: %#v; requests=%d", result, requests)
	}
	development, err := checker.Check(context.Background(), "dev")
	if err != nil {
		t.Fatal(err)
	}
	if development.CurrentComparable || development.UpdateAvailable {
		t.Fatalf("development build must not claim an update comparison: %#v", development)
	}
	preview, err := checker.Check(context.Background(), "v0.2.0-rc.1")
	if err != nil || !preview.CurrentPrerelease {
		t.Fatalf("preview build must remain visibly distinct: %#v, %v", preview, err)
	}
}

func TestCheckRejectsOversizeMalformedAndUntrustedResponses(t *testing.T) {
	tests := []string{
		strings.Repeat("x", maxResponseBytes+1),
		"{\"tag_name\":\"latest\",\"html_url\":\"https://github.com/chenrgSix/AgentRoom/releases/tag/latest\"}",
		"{\"tag_name\":\"v0.3.0\",\"html_url\":\"https://evil.example/chenrgSix/AgentRoom/releases/tag/v0.3.0\"}",
		"{\"tag_name\":\"v0.3.0\",\"html_url\":\"https://github.com/other/repo/releases/tag/v0.3.0\"}",
		"{\"tag_name\":\"v0.3.0\",\"html_url\":\"https://github.com/chenrgSix/AgentRoom/releases/tag/v0.3.0/extra\"}",
		"{\"tag_name\":\"v0.3.0\",\"html_url\":\"https://user@github.com/chenrgSix/AgentRoom/releases/tag/v0.3.0\"}",
		"{\"tag_name\":\"v0.3.0\",\"html_url\":\"https://github.com:443/chenrgSix/AgentRoom/releases/tag/v0.3.0\"}",
		"{\"tag_name\":\"v0.3.0\",\"html_url\":\"https://github.com/chenrgSix/AgentRoom/releases/tag/v0.3.0?download=1\"}",
		"{\"tag_name\":\"v0.3.0\",\"html_url\":\"https://github.com/chenrgSix/AgentRoom/releases/tag/v0.3.0#asset\"}",
		"{\"tag_name\":\"v0.3.0\",\"html_url\":\"https://github.com/chenrgSix/AgentRoom/releases/tag/v0.2.0\"}",
		"{\"tag_name\":\"v0.3.0\",\"html_url\":\"https://github.com/chenrgSix/AgentRoom/releases/tag/v0.3.0\"}{}",
	}
	for index, body := range tests {
		server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
			fmt.Fprint(response, body)
		}))
		checker := &Checker{Client: server.Client(), Endpoint: server.URL}
		if _, err := checker.Check(context.Background(), "v0.2.0"); err == nil {
			t.Fatalf("case %d should fail", index)
		}
		server.Close()
	}
}

func TestCheckHonorsContextTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		<-request.Context().Done()
	}))
	defer server.Close()
	checker := &Checker{Client: server.Client(), Endpoint: server.URL}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := checker.Check(ctx, "v0.2.0"); err == nil {
		t.Fatal("expected timeout")
	}
}

package admission

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/pairing"
)

func TestRuntimeAuthorityClientBindsAuthenticatedCurrentObservation(t *testing.T) {
	_, spec := runtimeFenceFixture(t)
	var calls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		if request.Method != http.MethodPost || request.URL.Path != "/api/bridge/governed-runtime-authority" ||
			request.Header.Get("authorization") != "Bearer device-secret" ||
			request.Header.Get(config.ServerTokenHeader) != "central-secret" || request.Header.Get("content-type") != "application/json" {
			t.Errorf("unexpected authority request: method=%s path=%s headers=%v", request.Method, request.URL.Path, request.Header)
		}
		var input map[string]any
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
			t.Error(err)
		}
		if len(input) != 6 || input["version"] != float64(1) || input["runId"] != spec.RunID || input["leaseId"] != spec.LeaseID ||
			input["manifestDigest"] != spec.ManifestDigest || input["workspaceRef"] != spec.WorkspaceRef ||
			input["workspaceGeneration"] != spec.WorkspaceGeneration {
			t.Errorf("changed authority request: %+v", input)
		}
		_ = json.NewEncoder(writer).Encode(authorityView(spec, runtimeFenceNow.Add(time.Minute)))
	}))
	defer server.Close()
	client := NewRuntimeAuthorityClient(config.Config{ServerURL: server.URL, ServerToken: "central-secret"},
		pairing.Credential{ServerURL: server.URL, Token: "device-secret"})
	view, err := client.Check(context.Background(), spec)
	if err != nil || view != authorityView(spec, runtimeFenceNow.Add(time.Minute)) || calls.Load() != 1 {
		t.Fatalf("view=%+v err=%v calls=%d", view, err, calls.Load())
	}
}

func TestRuntimeAuthorityClientRejectsStaleMalformedAndForeignResponses(t *testing.T) {
	for name, response := range map[string]func(*RuntimeAuthorityView, http.ResponseWriter){
		"run":       func(view *RuntimeAuthorityView, _ http.ResponseWriter) { view.RunID = "run_foreign0001" },
		"lease":     func(view *RuntimeAuthorityView, _ http.ResponseWriter) { view.LeaseID = "lease_foreign0001" },
		"manifest":  func(view *RuntimeAuthorityView, _ http.ResponseWriter) { view.ManifestDigest = strings.Repeat("f", 64) },
		"workspace": func(view *RuntimeAuthorityView, _ http.ResponseWriter) { view.WorkspaceRef = "workspace_foreign0001" },
		"generation": func(view *RuntimeAuthorityView, _ http.ResponseWriter) {
			view.WorkspaceGeneration = strings.Repeat("f", 64)
		},
		"state":    func(view *RuntimeAuthorityView, _ http.ResponseWriter) { view.State = "revoked" },
		"revision": func(view *RuntimeAuthorityView, _ http.ResponseWriter) { view.LeaseRevision++ },
		"expiry":   func(view *RuntimeAuthorityView, _ http.ResponseWriter) { view.ExpiresAt = "2026-08-31T10:19:00Z" },
		"checked at expiry": func(view *RuntimeAuthorityView, _ http.ResponseWriter) {
			view.CheckedAt = "2026-08-31T10:20:00Z"
		},
		"unknown field": func(_ *RuntimeAuthorityView, writer http.ResponseWriter) {
			_, _ = writer.Write([]byte(`{"version":1,"unknown":true}`))
		},
	} {
		t.Run(name, func(t *testing.T) {
			_, spec := runtimeFenceFixture(t)
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				view := authorityView(spec, runtimeFenceNow.Add(time.Minute))
				response(&view, writer)
				if name != "unknown field" {
					_ = json.NewEncoder(writer).Encode(view)
				}
			}))
			defer server.Close()
			client := NewRuntimeAuthorityClient(config.Config{ServerURL: server.URL},
				pairing.Credential{ServerURL: server.URL, Token: "device-secret"})
			if _, err := client.Check(context.Background(), spec); !errors.Is(err, ErrAdmissionChanged) {
				t.Fatalf("error=%v", err)
			}
		})
	}
}

func TestRuntimeAuthorityClientFailsClosedBeforeNetworkAndOnRejection(t *testing.T) {
	_, spec := runtimeFenceFixture(t)
	var calls atomic.Int64
	status := http.StatusConflict
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		writer.WriteHeader(status)
	}))
	defer server.Close()
	client := NewRuntimeAuthorityClient(config.Config{ServerURL: server.URL},
		pairing.Credential{ServerURL: server.URL, Token: "device-secret"})
	if _, err := client.Check(context.Background(), spec); !errors.Is(err, ErrAdmissionNotCurrent) || calls.Load() != 1 {
		t.Fatalf("rejection error=%v calls=%d", err, calls.Load())
	}
	status = http.StatusServiceUnavailable
	if _, err := client.Check(context.Background(), spec); !errors.Is(err, ErrAuthorityUnavailable) || calls.Load() != 2 {
		t.Fatalf("unavailable error=%v calls=%d", err, calls.Load())
	}

	invalid := spec
	invalid.ManifestDigest = "bad"
	if _, err := client.Check(context.Background(), invalid); !errors.Is(err, ErrAdmissionInvalid) || calls.Load() != 2 {
		t.Fatalf("invalid error=%v calls=%d", err, calls.Load())
	}
	foreign := NewRuntimeAuthorityClient(config.Config{ServerURL: server.URL},
		pairing.Credential{ServerURL: "https://foreign.example", Token: "device-secret"})
	if _, err := foreign.Check(context.Background(), spec); !errors.Is(err, ErrAdmissionInvalid) || calls.Load() != 2 {
		t.Fatalf("foreign origin error=%v calls=%d", err, calls.Load())
	}
	missing := NewRuntimeAuthorityClient(config.Config{ServerURL: server.URL}, pairing.Credential{ServerURL: server.URL})
	if _, err := missing.Check(context.Background(), spec); !errors.Is(err, ErrAdmissionInvalid) || calls.Load() != 2 {
		t.Fatalf("missing credential error=%v calls=%d", err, calls.Load())
	}
}

func authorityView(spec RuntimeAdmissionSpec, checked time.Time) RuntimeAuthorityView {
	return RuntimeAuthorityView{Version: 1, RunID: spec.RunID, LeaseID: spec.LeaseID,
		ManifestDigest: spec.ManifestDigest, WorkspaceRef: spec.WorkspaceRef, WorkspaceGeneration: spec.WorkspaceGeneration,
		State: "active", LeaseRevision: 1, CheckedAt: checked.UTC().Format(time.RFC3339Nano), ExpiresAt: spec.WorkspaceExpiresAt}
}

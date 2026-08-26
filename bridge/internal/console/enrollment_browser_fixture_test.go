package console

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"

	"agentroom.dev/bridge/internal/config"
	"agentroom.dev/bridge/internal/enrollment"
	"agentroom.dev/bridge/internal/operations"
	"agentroom.dev/bridge/internal/pairing"
)

// Opt-in browser fixture: temporary config, fake credentials, and no central
// network calls. Control routes exist only in this test, never in the binary.
func TestPairingBrowserFixture(t *testing.T) {
	if os.Getenv("AGENTROOM_PAIRING_UI_FIXTURE") != "1" {
		t.Skip("opt-in isolated browser fixture")
	}
	var mu sync.Mutex
	var decision chan bool
	dependencies := inertDependencies()
	dependencies.Enroll = func(ctx context.Context, cfg config.Config, show func(enrollment.Challenge)) (pairing.Credential, error) {
		result := make(chan bool, 1)
		mu.Lock()
		decision = result
		mu.Unlock()
		show(enrollment.Challenge{UserCode: "ABCD-1234", ExpiresAt: time.Now().Add(10 * time.Minute)})
		select {
		case accepted := <-result:
			if !accepted {
				return pairing.Credential{}, fmt.Errorf("Fixture: central service unavailable")
			}
			return approvedRecoveryCredential(cfg), nil
		case <-ctx.Done():
			return pairing.Credential{}, ctx.Err()
		}
	}
	dependencies.RunBridge = func(ctx context.Context, _ config.Config, _ pairing.Credential, observer operations.Observer) error {
		observer.Connection(operations.ConnectionEvent{State: operations.ConnectionOnline, At: time.Now()})
		<-ctx.Done()
		return nil
	}
	service, _ := pairedRecoveryService(t, dependencies)
	if _, err := service.StartBridge(); err != nil {
		t.Fatal(err)
	}
	finished := make(chan struct{})
	var stop sync.Once
	mux := http.NewServeMux()
	mux.HandleFunc("POST /fixture/expire", func(response http.ResponseWriter, _ *http.Request) {
		service.mu.Lock()
		service.state.JoinExpiresAt = time.Now().Add(-time.Second).Format(time.RFC3339Nano)
		service.mu.Unlock()
		response.WriteHeader(http.StatusNoContent)
	})
	for _, path := range []string{"approve", "fail"} {
		mux.HandleFunc("POST /fixture/"+path, func(response http.ResponseWriter, _ *http.Request) {
			mu.Lock()
			defer mu.Unlock()
			if decision == nil {
				response.WriteHeader(http.StatusConflict)
				return
			}
			select {
			case decision <- path == "approve":
				response.WriteHeader(http.StatusNoContent)
			default:
				response.WriteHeader(http.StatusConflict)
			}
		})
	}
	mux.HandleFunc("POST /fixture/stop", func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusNoContent)
		stop.Do(func() { close(finished) })
	})
	mux.Handle("/", service.Handler())
	server := httptest.NewServer(mux)
	defer server.Close()
	fmt.Printf("PAIRING_FIXTURE_URL=%s/?token=%s\n", server.URL, service.Token())
	select {
	case <-finished:
	case <-time.After(20 * time.Minute):
		t.Fatal("browser fixture timed out")
	}
}

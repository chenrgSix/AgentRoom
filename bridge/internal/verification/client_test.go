package verification

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/pairing"
	execution "convenewire.dev/contracts/generated/go/execution"
	wire "convenewire.dev/contracts/generated/go/runtime"
)

func TestClientRecoversLostReceiptResponseByExactLookup(t *testing.T) {
	var receipt execution.VerificationReceipt
	verificationWireFixture(t, "execution runtime: valid verification receipt", &receipt)
	raw, _ := json.Marshal(receipt)
	digest, _ := wire.ExecutionDigest(raw)
	retained := RetainedReceipt{Receipt: receipt, ReceiptDigest: digest,
		RecordedAt: receipt.FinishedAt}
	postCalls, getCalls := 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/bridge/verification-receipts" && r.Method == http.MethodPost {
			postCalls++
			var observed execution.VerificationReceipt
			if json.NewDecoder(r.Body).Decode(&observed) != nil || !sameCanonical(observed, receipt) {
				t.Fatal("client changed receipt submission")
			}
			connection, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Fatal(err)
			}
			_ = connection.Close()
			return
		}
		if r.URL.Path == "/api/bridge/repository-verifications/"+receipt.OperationID+"/receipt" &&
			r.Method == http.MethodGet {
			getCalls++
			_ = json.NewEncoder(w).Encode(retained)
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()
	client := NewClient(config.Config{ServerURL: server.URL}, pairing.Credential{
		ServerURL: server.URL, Token: "secret",
	})
	observed, err := client.Retain(context.Background(), receipt)
	if err != nil || !sameCanonical(observed, retained) || postCalls != 1 || getCalls != 1 {
		t.Fatalf("response loss did not converge by lookup: %+v %v post=%d get=%d",
			observed, err, postCalls, getCalls)
	}
}

func verificationWireFixture(t *testing.T, name string, target any) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "packages", "contracts",
		"fixtures", "execution-runtime-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var suite struct {
		Cases []struct {
			Name     string
			Instance json.RawMessage
		}
	}
	if err := json.Unmarshal(raw, &suite); err != nil {
		t.Fatal(err)
	}
	for _, entry := range suite.Cases {
		if entry.Name == name {
			if err := json.Unmarshal(entry.Instance, target); err != nil {
				t.Fatal(err)
			}
			return
		}
	}
	t.Fatal("fixture not found", name)
}

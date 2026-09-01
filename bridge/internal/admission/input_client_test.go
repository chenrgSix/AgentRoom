package admission

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/pairing"
	"convenewire.dev/bridge/internal/repository"
	execution "convenewire.dev/contracts/generated/go/execution"
)

func TestExecutionInputClientLoadsExactOrderedPatches(t *testing.T) {
	manifest, content := executionInputFixture(t, 2)
	requested := make([]string, 0, len(manifest.Inputs))
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.Header.Get("authorization") != "Bearer device-secret" ||
			request.Header.Get("accept") != "text/x-diff" || request.Header.Get(config.ServerTokenHeader) != "central-secret" {
			t.Errorf("unexpected input request: method=%s path=%s headers=%v", request.Method, request.URL.Path, request.Header)
		}
		for _, binding := range manifest.Inputs {
			expectedPath := "/api/bridge/runs/" + manifest.Scope.RunID + "/execution-inputs/" + binding.BindingID + "/content"
			if request.URL.Path != expectedPath {
				continue
			}
			requested = append(requested, binding.BindingID)
			writeExecutionInput(writer, binding, content[binding.BindingID])
			return
		}
		http.NotFound(writer, request)
	}))
	defer server.Close()
	client := NewExecutionInputClient(config.Config{ServerURL: server.URL, ServerToken: "central-secret"},
		pairing.Credential{ServerURL: server.URL, DeviceID: manifest.Scope.DeviceID, Token: "device-secret"})
	inputs, err := client.LoadPatches(context.Background(), manifest)
	if err != nil {
		t.Fatal(err)
	}
	want := make([]repository.PatchInput, 0, len(manifest.Inputs))
	for _, binding := range manifest.Inputs {
		want = append(want, repository.PatchInput{BindingID: binding.BindingID,
			SHA256: binding.Artifact.ContentDigest, Bytes: content[binding.BindingID]})
	}
	if !reflect.DeepEqual(inputs, want) || !reflect.DeepEqual(requested,
		[]string{manifest.Inputs[0].BindingID, manifest.Inputs[1].BindingID}) {
		t.Fatalf("inputs=%+v requested=%v", inputs, requested)
	}
}

func TestExecutionInputClientRejectsResponseDriftAndUnavailability(t *testing.T) {
	tests := []struct {
		name   string
		status int
		change func(http.ResponseWriter, *execution.GovernedExecutionManifestInput, *[]byte)
		want   error
	}{
		{name: "not current", status: http.StatusConflict, want: ErrAdmissionNotCurrent},
		{name: "unavailable", status: http.StatusServiceUnavailable, want: ErrInputUnavailable},
		{name: "binding header", change: func(writer http.ResponseWriter, _ *execution.GovernedExecutionManifestInput, _ *[]byte) {
			writer.Header().Set("x-convenewire-input-id", "input_foreign0001")
		}, want: ErrAdmissionChanged},
		{name: "digest header", change: func(writer http.ResponseWriter, _ *execution.GovernedExecutionManifestInput, _ *[]byte) {
			writer.Header().Set("x-convenewire-content-sha256", strings.Repeat("f", 64))
		}, want: ErrAdmissionChanged},
		{name: "media type", change: func(writer http.ResponseWriter, _ *execution.GovernedExecutionManifestInput, _ *[]byte) {
			writer.Header().Set("content-type", "application/octet-stream")
		}, want: ErrAdmissionChanged},
		{name: "content encoding", change: func(writer http.ResponseWriter, _ *execution.GovernedExecutionManifestInput, _ *[]byte) {
			writer.Header().Set("content-encoding", "gzip")
		}, want: ErrAdmissionChanged},
		{name: "cache policy", change: func(writer http.ResponseWriter, _ *execution.GovernedExecutionManifestInput, _ *[]byte) {
			writer.Header().Del("cache-control")
		}, want: ErrAdmissionChanged},
		{name: "nosniff", change: func(writer http.ResponseWriter, _ *execution.GovernedExecutionManifestInput, _ *[]byte) {
			writer.Header().Del("x-content-type-options")
		}, want: ErrAdmissionChanged},
		{name: "declared length", change: func(writer http.ResponseWriter, binding *execution.GovernedExecutionManifestInput, _ *[]byte) {
			writer.Header().Set("content-length", strconv.FormatInt(binding.Artifact.ByteLength+1, 10))
		}, want: ErrAdmissionChanged},
		{name: "body digest", change: func(_ http.ResponseWriter, _ *execution.GovernedExecutionManifestInput, body *[]byte) {
			(*body)[0] ^= 1
		}, want: ErrAdmissionChanged},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			manifest, content := executionInputFixture(t, 1)
			binding := manifest.Inputs[0]
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				if test.status != 0 && test.status != http.StatusOK {
					writer.WriteHeader(test.status)
					return
				}
				body := append([]byte{}, content[binding.BindingID]...)
				writeExecutionInputHeaders(writer, binding)
				if test.change != nil {
					test.change(writer, &binding, &body)
				}
				_, _ = writer.Write(body)
			}))
			defer server.Close()
			client := NewExecutionInputClient(config.Config{ServerURL: server.URL},
				pairing.Credential{ServerURL: server.URL, DeviceID: manifest.Scope.DeviceID, Token: "device-secret"})
			if _, err := client.LoadPatches(context.Background(), manifest); !errors.Is(err, test.want) {
				t.Fatalf("error=%v", err)
			}
		})
	}
}

func TestExecutionInputClientRejectsRedirectAndInvalidIntentBeforeContent(t *testing.T) {
	t.Run("redirect", func(t *testing.T) {
		manifest, _ := executionInputFixture(t, 1)
		var redirected atomic.Int64
		server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			if request.URL.Path == "/redirected" {
				redirected.Add(1)
				return
			}
			http.Redirect(writer, request, "/redirected", http.StatusFound)
		}))
		defer server.Close()
		client := NewExecutionInputClient(config.Config{ServerURL: server.URL},
			pairing.Credential{ServerURL: server.URL, DeviceID: manifest.Scope.DeviceID, Token: "device-secret"})
		if _, err := client.LoadPatches(context.Background(), manifest); !errors.Is(err, ErrInputUnavailable) || redirected.Load() != 0 {
			t.Fatalf("error=%v redirected=%d", err, redirected.Load())
		}
	})

	manifest, _ := executionInputFixture(t, 2)
	var calls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { calls.Add(1) }))
	defer server.Close()
	validCredential := pairing.Credential{ServerURL: server.URL, DeviceID: manifest.Scope.DeviceID, Token: "device-secret"}
	for _, test := range []struct {
		name       string
		credential pairing.Credential
		change     func(*execution.GovernedExecutionManifest)
	}{
		{name: "missing token", credential: pairing.Credential{ServerURL: server.URL, DeviceID: manifest.Scope.DeviceID}},
		{name: "foreign origin", credential: pairing.Credential{ServerURL: "https://foreign.example", DeviceID: manifest.Scope.DeviceID, Token: "secret"}},
		{name: "foreign device", credential: pairing.Credential{ServerURL: server.URL, DeviceID: "device_foreign0001", Token: "secret"}},
		{name: "manifest digest", credential: validCredential, change: func(candidate *execution.GovernedExecutionManifest) {
			candidate.ManifestDigest = strings.Repeat("f", 64)
		}},
		{name: "commit input", credential: validCredential, change: func(candidate *execution.GovernedExecutionManifest) {
			candidate.Inputs[0].Artifact.Kind = execution.Commit
			rehashExecutionInputManifest(t, candidate)
		}},
		{name: "duplicate input", credential: validCredential, change: func(candidate *execution.GovernedExecutionManifest) {
			candidate.Inputs[1] = candidate.Inputs[0]
			rehashExecutionInputManifest(t, candidate)
		}},
		{name: "foreign destination", credential: validCredential, change: func(candidate *execution.GovernedExecutionManifest) {
			candidate.Inputs[0].DestinationRunID = "run_foreign0001"
			rehashExecutionInputManifest(t, candidate)
		}},
		{name: "oversized input", credential: validCredential, change: func(candidate *execution.GovernedExecutionManifest) {
			candidate.Inputs[0].Artifact.ByteLength = maxGovernedInputBytes + 1
			rehashExecutionInputManifest(t, candidate)
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			candidate := manifest
			candidate.Inputs = append([]execution.GovernedExecutionManifestInput{}, manifest.Inputs...)
			if test.change != nil {
				test.change(&candidate)
			}
			client := NewExecutionInputClient(config.Config{ServerURL: server.URL}, test.credential)
			if _, err := client.LoadPatches(context.Background(), candidate); !errors.Is(err, ErrAdmissionInvalid) || calls.Load() != 0 {
				t.Fatalf("error=%v calls=%d", err, calls.Load())
			}
		})
	}

	t.Run("canceled", func(t *testing.T) {
		candidate, _ := executionInputFixture(t, 1)
		client := NewExecutionInputClient(config.Config{ServerURL: server.URL}, pairing.Credential{
			ServerURL: server.URL, DeviceID: candidate.Scope.DeviceID, Token: "device-secret"})
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if _, err := client.LoadPatches(ctx, candidate); !errors.Is(err, context.Canceled) || calls.Load() != 0 {
			t.Fatalf("error=%v calls=%d", err, calls.Load())
		}
	})
}

func executionInputFixture(t *testing.T, count int) (execution.GovernedExecutionManifest, map[string][]byte) {
	t.Helper()
	manifest := runtimeManifestFixture(t)
	manifest.VerificationProfiles = []execution.GovernedExecutionManifestVerificationProfile{}
	base := manifest.Inputs[0]
	manifest.Inputs = make([]execution.GovernedExecutionManifestInput, count)
	content := make(map[string][]byte, count)
	for index := range manifest.Inputs {
		binding := base
		binding.BindingID = "input_runtime000" + strconv.Itoa(index+1)
		binding.Artifact.ArtifactID = "artifact_runtime0" + strconv.Itoa(index+1)
		body := []byte("diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new" + strconv.Itoa(index+1) + "\n")
		hash := sha256.Sum256(body)
		binding.Artifact.Kind = execution.Patch
		binding.Artifact.ByteLength = int64(len(body))
		binding.Artifact.ContentDigest = hex.EncodeToString(hash[:])
		manifest.Inputs[index] = binding
		content[binding.BindingID] = body
	}
	rehashExecutionInputManifest(t, &manifest)
	return manifest, content
}

func rehashExecutionInputManifest(t *testing.T, manifest *execution.GovernedExecutionManifest) {
	t.Helper()
	var err error
	manifest.InputDigest, err = executionDigest(manifest.Inputs, "")
	if err != nil {
		t.Fatal(err)
	}
	manifest.ManifestDigest, err = executionDigest(*manifest, "manifestDigest")
	if err != nil {
		t.Fatal(err)
	}
}

func writeExecutionInput(writer http.ResponseWriter, binding execution.GovernedExecutionManifestInput, body []byte) {
	writeExecutionInputHeaders(writer, binding)
	_, _ = writer.Write(body)
}

func writeExecutionInputHeaders(writer http.ResponseWriter, binding execution.GovernedExecutionManifestInput) {
	writer.Header().Set("cache-control", "no-store")
	writer.Header().Set("content-type", "text/x-diff")
	writer.Header().Set("content-length", strconv.FormatInt(binding.Artifact.ByteLength, 10))
	writer.Header().Set("x-content-type-options", "nosniff")
	writer.Header().Set("x-convenewire-input-id", binding.BindingID)
	writer.Header().Set("x-convenewire-content-sha256", binding.Artifact.ContentDigest)
}

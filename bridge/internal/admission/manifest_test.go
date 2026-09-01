package admission

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	contracts "convenewire.dev/contracts/generated/go"
)

func TestDecodeGovernedManifestBindsExactDeliveryContext(t *testing.T) {
	request := governedDeliveryFixture(t)
	manifest, err := DecodeGovernedManifest(request)
	if err != nil {
		t.Fatal(err)
	}
	expected := runtimeManifestFixture(t)
	if !reflect.DeepEqual(manifest, expected) {
		t.Fatalf("decoded manifest changed wire value\nactual=%+v\nexpected=%+v", manifest, expected)
	}
}

func TestDecodeGovernedManifestRejectsOuterIdentityAndRevisionDrift(t *testing.T) {
	base := governedDeliveryFixture(t)
	for name, change := range map[string]func(*contracts.RunRequestedPayload){
		"missing context":   func(value *contracts.RunRequestedPayload) { value.ContextManifest = nil },
		"missing execution": func(value *contracts.RunRequestedPayload) { value.ContextManifest.Execution = nil },
		"missing task":      func(value *contracts.RunRequestedPayload) { value.TaskID = nil },
		"run":               func(value *contracts.RunRequestedPayload) { value.RunID = "run_foreign0001" },
		"context run":       func(value *contracts.RunRequestedPayload) { value.ContextManifest.RunID = "run_foreign0001" },
		"room":              func(value *contracts.RunRequestedPayload) { value.RoomID = "room_foreign0001" },
		"task": func(value *contracts.RunRequestedPayload) {
			task := "task_foreign0001"
			value.TaskID = &task
		},
		"context task":        func(value *contracts.RunRequestedPayload) { value.ContextManifest.TaskID = "task_foreign0001" },
		"task revision":       func(value *contracts.RunRequestedPayload) { value.ContextManifest.TaskRevision++ },
		"definition revision": func(value *contracts.RunRequestedPayload) { value.ContextManifest.DefinitionRevision++ },
		"criteria revision":   func(value *contracts.RunRequestedPayload) { value.ContextManifest.CriteriaRevision++ },
		"agent":               func(value *contracts.RunRequestedPayload) { value.TargetAgentID = "agent_foreign0001" },
		"context agent":       func(value *contracts.RunRequestedPayload) { value.ContextManifest.Target.AgentID = "agent_foreign0001" },
		"missing device":      func(value *contracts.RunRequestedPayload) { value.ContextManifest.Target.DeviceID = nil },
		"device": func(value *contracts.RunRequestedPayload) {
			device := "device_foreign0001"
			value.ContextManifest.Target.DeviceID = &device
		},
		"runtime kind":     func(value *contracts.RunRequestedPayload) { value.ContextManifest.Target.RuntimeKind = contracts.Pi },
		"manifest version": func(value *contracts.RunRequestedPayload) { value.ContextManifest.ManifestVersion = "2.0" },
		"deadline":         func(value *contracts.RunRequestedPayload) { value.Deadline = value.Deadline.Add(time.Second) },
		"recorded after workspace issue": func(value *contracts.RunRequestedPayload) {
			value.ContextManifest.RecordedAt = value.ContextManifest.RecordedAt.Add(time.Second)
		},
	} {
		t.Run(name, func(t *testing.T) {
			candidate := cloneGovernedRequest(t, base)
			change(&candidate)
			if _, err := DecodeGovernedManifest(candidate); !errors.Is(err, ErrAdmissionInvalid) {
				t.Fatalf("error=%v", err)
			}
		})
	}
}

func TestDecodeGovernedManifestRejectsInvalidInnerDigests(t *testing.T) {
	for name, change := range map[string]func(*contracts.Execution){
		"manifest": func(value *contracts.Execution) {
			value.ManifestDigest = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
		},
		"inputs": func(value *contracts.Execution) {
			value.InputDigest = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
		},
		"scope": func(value *contracts.Execution) { value.Scope.DispatchGeneration++ },
	} {
		t.Run(name, func(t *testing.T) {
			request := governedDeliveryFixture(t)
			change(request.ContextManifest.Execution)
			if _, err := DecodeGovernedManifest(request); !errors.Is(err, ErrAdmissionInvalid) {
				t.Fatalf("error=%v", err)
			}
		})
	}
}

func TestValidateRuntimeAdmissionRequestJoinsExactRestartInventory(t *testing.T) {
	request := governedDeliveryFixture(t)
	store, spec := runtimeFenceFixture(t)
	view, err := store.Claim(spec, runtimeFenceNow)
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateRuntimeAdmissionRequest(request, view); err != nil {
		t.Fatal(err)
	}
	changed := view
	changed.Spec.WorkspaceGeneration = "workspace-generation-foreign"
	if err := ValidateRuntimeAdmissionRequest(request, changed); !errors.Is(err, ErrAdmissionChanged) {
		t.Fatalf("changed restart join error=%v", err)
	}
	invalid := view
	invalid.Spec.PreparedIdentityDigest = "bad"
	if err := ValidateRuntimeAdmissionRequest(request, invalid); !errors.Is(err, ErrAdmissionInvalid) {
		t.Fatalf("invalid restart inventory error=%v", err)
	}
}

func governedDeliveryFixture(t *testing.T) contracts.RunRequestedPayload {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "packages", "contracts", "fixtures", "execution-runtime-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var suite struct {
		Cases []struct {
			Name     string
			Instance struct {
				Payload json.RawMessage `json:"payload"`
			} `json:"instance"`
		}
	}
	if err := json.Unmarshal(raw, &suite); err != nil {
		t.Fatal(err)
	}
	for _, entry := range suite.Cases {
		if entry.Name == "execution runtime: valid governed wire delivery" {
			var request contracts.RunRequestedPayload
			if err := json.Unmarshal(entry.Instance.Payload, &request); err != nil {
				t.Fatal(err)
			}
			return request
		}
	}
	t.Fatal("governed delivery fixture missing")
	return contracts.RunRequestedPayload{}
}

func cloneGovernedRequest(t *testing.T, value contracts.RunRequestedPayload) contracts.RunRequestedPayload {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var cloned contracts.RunRequestedPayload
	if err := json.Unmarshal(raw, &cloned); err != nil {
		t.Fatal(err)
	}
	return cloned
}

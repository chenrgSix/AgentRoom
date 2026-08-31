package contracts_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	contracts "convenewire.dev/contracts/generated/go"
	execution "convenewire.dev/contracts/generated/go/execution"
	runtimecontracts "convenewire.dev/contracts/generated/go/runtime"
)

func TestSharedCanonicalExecutionJSON(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(packageRoot(t), "fixtures", "execution-canonical-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var suite struct {
		Cases []struct{ Name, Raw, Canonical, Digest string }
	}
	if err := json.Unmarshal(raw, &suite); err != nil {
		t.Fatal(err)
	}
	for _, entry := range suite.Cases {
		t.Run(entry.Name, func(t *testing.T) {
			canonical, err := runtimecontracts.CanonicalExecutionJSON([]byte(entry.Raw))
			if err != nil || string(canonical) != entry.Canonical {
				t.Fatalf("canonical mismatch: %q %v", canonical, err)
			}
			digest, err := runtimecontracts.ExecutionDigest([]byte(entry.Raw))
			if err != nil || digest != entry.Digest {
				t.Fatalf("digest mismatch: %s %v", digest, err)
			}
			if entry.Name == "frozen governed manifest" {
				normalized, err := runtimecontracts.ValidateAndNormalizeExecutionCommand("executionManifest", []byte(entry.Raw))
				if err != nil {
					t.Fatal(err)
				}
				var manifest execution.GovernedExecutionManifest
				if err := json.Unmarshal(normalized, &manifest); err != nil {
					t.Fatal(err)
				}
				typed, err := json.Marshal(manifest)
				if err != nil {
					t.Fatal(err)
				}
				var fields map[string]json.RawMessage
				if err := json.Unmarshal(typed, &fields); err != nil {
					t.Fatal(err)
				}
				delete(fields, "manifestDigest")
				unsigned, err := json.Marshal(fields)
				if err != nil {
					t.Fatal(err)
				}
				actual, err := runtimecontracts.ExecutionDigest(unsigned)
				if err != nil || actual != manifest.ManifestDigest {
					t.Fatal("typed Go manifest lost its Node digest", actual, err)
				}
			}
		})
	}
}

func TestExecutionCanonicalJSONRejectsAmbiguousAndUnboundedValues(t *testing.T) {
	for _, raw := range []string{
		`{"n":1,"n":2}`, `{"n":1,"\u006e":2}`, `{"n":9007199254740992}`, `{"n":0.5}`,
		`{"n":1e513}`, `{"n":1e-513}`, `{"n":null} {}`, `{"s":"\ud800"}`, `{"s":"\udc00"}`,
		`{"constructor":1}`, `{"__proto__":{}}`, `{"prototype":null}`,
		strings.Repeat("[", 25) + "null" + strings.Repeat("]", 25), `"` + strings.Repeat("x", 512<<10) + `"`,
		string([]byte{'"', 0xff, '"'}),
	} {
		if _, err := runtimecontracts.CanonicalExecutionJSON([]byte(raw)); err == nil {
			t.Fatalf("accepted invalid value %q", raw[:min(len(raw), 80)])
		}
	}
}

func TestExecutionCanonicalSizeBoundAfterNumberExpansion(t *testing.T) {
	prefix := `[` + strings.Repeat(`1e15,`, 1000) + `"`
	raw := prefix + strings.Repeat("x", (512<<10)-len(prefix)-2) + `"]`
	if len(raw) != 512<<10 {
		t.Fatal("test input does not exercise the exact wire size boundary")
	}
	if _, err := runtimecontracts.CanonicalExecutionJSON([]byte(raw)); err == nil {
		t.Fatal("numeric expansion exceeded the canonical byte limit")
	}
	if _, err := runtimecontracts.CanonicalExecutionJSON([]byte(`"` + strings.Repeat("x", (512<<10)-2) + `"`)); err != nil {
		t.Fatal("exactly bounded canonical string rejected", err)
	}
}

func TestExecutionStandaloneNormalizationAndRawGuards(t *testing.T) {
	const raw = `{"version":1.0,"workspaceBoundary":"enforced","preventivePathEnforcement":false,"operations":["prepare","capture"]}`
	normalized, err := runtimecontracts.ValidateAndNormalizeExecutionCommand("executionCapability", []byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	var capability execution.GovernedExecutionCapability
	if err := json.Unmarshal(normalized, &capability); err != nil {
		t.Fatal("normalization did not produce typed integer JSON", err)
	}
	if capability.Version != 1 {
		t.Fatal("normalized capability version changed")
	}
	for _, invalid := range []string{
		strings.Replace(raw, `"version"`, `"Version"`, 1),
		strings.Replace(raw, `"version":1.0`, `"version":1,"version":1`, 1),
		strings.Replace(raw, `"version":1.0`, `"version":1,"Version":1`, 1),
		strings.Replace(raw, `"version":1.0`, `"version":1,"extension":true`, 1),
		strings.Replace(raw, `1.0`, `1.0000000000000001`, 1),
		strings.Replace(raw, `1.0`, `2`, 1),
	} {
		if _, err := runtimecontracts.ValidateAndNormalizeExecutionCommand("executionCapability", []byte(invalid)); err == nil {
			t.Fatal("accepted ambiguous or schema-invalid capability", invalid)
		}
	}
}

func TestExecutionStandaloneSchemaFixtures(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(packageRoot(t), "fixtures", "execution-runtime-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var suite fixtureSuite
	if err := json.Unmarshal(raw, &suite); err != nil {
		t.Fatal(err)
	}
	kinds := map[string]string{"manifest": "executionManifest", "inputBinding": "executionInputBinding",
		"capability": "executionCapability", "bindingSummary": "repositoryBinding", "grantSummary": "executionGrant",
		"operationRequest": "repositoryOperation", "operationReceipt": "repositoryReceipt", "checkpoint": "executionCheckpoint",
		"verificationReceipt": "verificationReceipt"}
	checked := 0
	for _, entry := range suite.Cases {
		fragment := strings.Split(entry.SchemaID, "#/$defs/")
		if len(fragment) != 2 || kinds[fragment[1]] == "" {
			continue
		}
		checked++
		t.Run(entry.Name, func(t *testing.T) {
			err := runtimecontracts.ValidateExecutionCommand(kinds[fragment[1]], entry.Instance)
			if (err == nil) != entry.Valid {
				t.Fatalf("valid=%v err=%v", entry.Valid, err)
			}
		})
	}
	if checked == 0 {
		t.Fatal("no standalone schema fixtures checked")
	}
	if runtimecontracts.ValidateExecutionCommand("unknown", []byte(`{}`)) == nil {
		t.Fatal("unknown schema accepted")
	}
}

func TestExecutionFractionalUTCStringsSurviveTypedWireRoundTrip(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(packageRoot(t), "fixtures", "execution-runtime-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var suite fixtureSuite
	if err := json.Unmarshal(raw, &suite); err != nil {
		t.Fatal(err)
	}
	for _, entry := range suite.Cases {
		var value any
		switch entry.Name {
		case "execution runtime: valid governed wire delivery":
			value = &contracts.RunRequestedMessage{}
		case "execution runtime: valid manifest":
			value = &execution.GovernedExecutionManifest{}
		case "execution runtime: valid capture operation":
			value = &execution.RepositoryOperationRequest{}
		case "execution runtime: valid checkpoint":
			value = &execution.RepositoryCheckpoint{}
		default:
			continue
		}
		t.Run(entry.Name, func(t *testing.T) {
			original := strings.ReplaceAll(string(entry.Instance), ":00Z", ":00.000Z")
			if entry.Name == "execution runtime: valid governed wire delivery" {
				// Only execution fields are digest-bearing in this contract change;
				// legacy envelope/ContextManifest timestamps retain their old type.
				var wire map[string]json.RawMessage
				if err := json.Unmarshal(entry.Instance, &wire); err != nil {
					t.Fatal(err)
				}
				var payload map[string]json.RawMessage
				if err := json.Unmarshal(wire["payload"], &payload); err != nil {
					t.Fatal(err)
				}
				var context map[string]json.RawMessage
				if err := json.Unmarshal(payload["contextManifest"], &context); err != nil {
					t.Fatal(err)
				}
				context["execution"] = json.RawMessage(strings.ReplaceAll(string(context["execution"]), ":00Z", ":00.000Z"))
				payload["contextManifest"], err = json.Marshal(context)
				if err != nil {
					t.Fatal(err)
				}
				wire["payload"], err = json.Marshal(payload)
				if err != nil {
					t.Fatal(err)
				}
				encoded, err := json.Marshal(wire)
				if err != nil {
					t.Fatal(err)
				}
				original = string(encoded)
			}
			if err := json.Unmarshal([]byte(original), value); err != nil {
				t.Fatal(err)
			}
			encoded, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(decodeJSON(t, []byte(original)), decodeJSON(t, encoded)) {
				t.Fatal("fractional UTC string changed")
			}
		})
	}
}

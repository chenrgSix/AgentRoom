package contracts_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	runtimecontracts "convenewire.dev/contracts/generated/go/runtime"
)

func TestGovernedExecutionWireDecoder(t *testing.T) {
	source, err := os.ReadFile(filepath.Join(packageRoot(t), "fixtures", "execution-runtime-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var suite fixtureSuite
	if err := json.Unmarshal(source, &suite); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range suite.Cases {
		if fixture.SchemaID != "https://agentroom.dev/schemas/bridge/messages.schema.json" {
			continue
		}
		t.Run(fixture.Name, func(t *testing.T) {
			var compact json.RawMessage
			if err := json.Unmarshal(fixture.Instance, &compact); err != nil {
				t.Fatal(err)
			}
			value, err := runtimecontracts.DecodeBridgeMessage(compact)
			if (err == nil) != fixture.Valid {
				t.Fatalf("valid=%t err=%v", fixture.Valid, err)
			}
			if !fixture.Valid {
				return
			}
			encoded, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			if err := runtimecontracts.ValidateBridgeMessage(encoded); err != nil {
				t.Fatal(err)
			}
			var before, after any
			if err := json.Unmarshal(compact, &before); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(encoded, &after); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(before, after) {
				t.Fatal("typed wire round trip changed the governed payload")
			}
			if strings.Contains(fixture.Name, "wire delivery") {
				raw := string(encoded)
				for _, mutation := range [][2]string{
					{`"dispatchGeneration":1`, `"dispatchGeneration":1,"dispatchGeneration":2`},
					{`"dispatchGeneration":1`, `"dispatchGeneration":1,"dispatch\u0047eneration":2`},
					{`"dispatchGeneration":1`, `"DispatchGeneration":1`},
					{`"manifestDigest":`, `"ManifestDigest":`},
					{`"grant":{`, `"grant":{"command":"arbitrary",`},
					{`"planRevision":1`, `"planRevision":9007199254740992`},
				} {
					changed := strings.Replace(raw, mutation[0], mutation[1], 1)
					if changed == raw {
						t.Fatalf("mutation target missing: %s", mutation[0])
					}
					if _, err := runtimecontracts.DecodeBridgeMessage([]byte(changed)); err == nil {
						t.Fatalf("accepted %s", mutation[1])
					}
				}
			}
		})
	}
}

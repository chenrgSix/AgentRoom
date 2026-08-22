package contracts_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

type fixtureSuite struct {
	FixtureVersion string        `json:"fixtureVersion"`
	Cases          []fixtureCase `json:"cases"`
}

type fixtureCase struct {
	Name     string          `json:"name"`
	SchemaID string          `json:"schemaId"`
	Instance json.RawMessage `json:"instance"`
	Valid    bool            `json:"valid"`
}

func packageRoot(t *testing.T) string {
	t.Helper()
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate Go fixture test")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(filename), "..", ".."))
}

func decodeJSON(t *testing.T, source []byte) any {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(source))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		t.Fatalf("decode JSON: %v", err)
	}
	return value
}

func loadCompiler(t *testing.T, root string) *jsonschema.Compiler {
	t.Helper()
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	err := filepath.WalkDir(filepath.Join(root, "schemas"), func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || filepath.Ext(path) != ".json" {
			return nil
		}
		source, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		document := decodeJSON(t, source)
		object, ok := document.(map[string]any)
		if !ok {
			return fmt.Errorf("schema %s is not an object", path)
		}
		id, ok := object["$id"].(string)
		if !ok || id == "" {
			return fmt.Errorf("schema %s has no $id", path)
		}
		return compiler.AddResource(id, document)
	})
	if err != nil {
		t.Fatalf("load schemas: %v", err)
	}
	return compiler
}

func TestGoldenFixturesMatchJSONSchema(t *testing.T) {
	root := packageRoot(t)
	source, err := os.ReadFile(filepath.Join(root, "fixtures", "cases.json"))
	if err != nil {
		t.Fatalf("read fixtures: %v", err)
	}
	var suite fixtureSuite
	if err := json.Unmarshal(source, &suite); err != nil {
		t.Fatalf("decode fixtures: %v", err)
	}
	if suite.FixtureVersion == "" || len(suite.Cases) == 0 {
		t.Fatal("fixture suite must have a version and cases")
	}

	compiler := loadCompiler(t, root)
	for _, fixture := range suite.Cases {
		fixture := fixture
		t.Run(fixture.Name, func(t *testing.T) {
			schema, err := compiler.Compile(fixture.SchemaID)
			if err != nil {
				t.Fatalf("compile schema %s: %v", fixture.SchemaID, err)
			}
			instance := decodeJSON(t, fixture.Instance)
			encoded, err := json.Marshal(instance)
			if err != nil {
				t.Fatalf("encode fixture: %v", err)
			}
			validationErr := schema.Validate(decodeJSON(t, encoded))
			actual := validationErr == nil
			if actual != fixture.Valid {
				t.Fatalf("valid=%t, want %t: %v", actual, fixture.Valid, validationErr)
			}
		})
	}
}

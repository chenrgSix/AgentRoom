package buildidentity

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolveBindsExactSourceToExecutableBytes(t *testing.T) {
	executable := filepath.Join(t.TempDir(), "ConveneWire Bridge.exe")
	content := []byte("candidate executable fixture")
	if err := os.WriteFile(executable, content, 0o600); err != nil {
		t.Fatal(err)
	}
	wanted := sha256.Sum256(content)
	observation, err := resolve(strings.Repeat("a", 40), executable)
	if err != nil {
		t.Fatal(err)
	}
	if observation.SourceCommit != strings.Repeat("a", 40) ||
		observation.ExecutableSHA256 != hex.EncodeToString(wanted[:]) {
		t.Fatalf("unexpected build observation: %+v", observation)
	}
}

func TestResolveKeepsDevelopmentWireShapeAbsent(t *testing.T) {
	executable := filepath.Join(t.TempDir(), "bridge")
	if err := os.WriteFile(executable, []byte("development executable"), 0o600); err != nil {
		t.Fatal(err)
	}
	observation, err := resolve("", executable)
	if err != nil {
		t.Fatal(err)
	}
	if observation != (Observation{}) {
		t.Fatalf("development observation leaked a partial identity: %+v", observation)
	}
}

func TestResolveRejectsNonCanonicalSourceCommit(t *testing.T) {
	executable := filepath.Join(t.TempDir(), "bridge")
	if err := os.WriteFile(executable, []byte("candidate executable"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, source := range []string{strings.Repeat("A", 40), strings.Repeat("a", 39), "HEAD"} {
		if _, err := resolve(source, executable); err == nil {
			t.Fatalf("accepted non-canonical source commit %q", source)
		}
	}
}

func TestObservationRejectsPartialWireIdentity(t *testing.T) {
	for _, observation := range []Observation{
		{SourceCommit: strings.Repeat("a", 40)},
		{ExecutableSHA256: strings.Repeat("b", 64)},
		{SourceCommit: strings.Repeat("A", 40), ExecutableSHA256: strings.Repeat("b", 64)},
	} {
		if err := observation.Validate(); err == nil {
			t.Fatalf("accepted partial or non-canonical observation: %+v", observation)
		}
	}
}

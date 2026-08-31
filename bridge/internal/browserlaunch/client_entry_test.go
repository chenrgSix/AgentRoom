package browserlaunch

import (
	"errors"
	"strings"
	"testing"
)

func TestClientEntryUsesOnlyExactOriginAndFragmentProof(t *testing.T) {
	proof := strings.Repeat("t", 43)
	for _, platform := range []string{"darwin", "windows", "linux"} {
		called := false
		err := openClientEntry(platform, "https://team.example", proof, func(name string, args ...string) error {
			called = true
			if args[len(args)-1] != "https://team.example/#clientEntry="+proof || strings.Contains(name, "sh") {
				t.Fatal("unsafe browser target")
			}
			return nil
		})
		if err != nil || !called {
			t.Fatal("browser command was not dispatched", err)
		}
	}
	for _, origin := range []string{"http://team.example", "https://user@team.example", "https://team.example/redirect", "https://team.example?next=evil", "https://team.example#evil", "file:///private/secret", "javascript:alert(1)"} {
		if err := openClientEntry("darwin", origin, proof, func(string, ...string) error { t.Fatal("opened invalid origin"); return nil }); err == nil {
			t.Fatal("accepted unsafe origin")
		}
	}
	err := openClientEntry("darwin", "http://127.0.0.1:3000", proof, func(string, ...string) error { return errors.New(proof) })
	if err == nil || strings.Contains(err.Error(), proof) {
		t.Fatal("browser failure disclosed proof")
	}
}

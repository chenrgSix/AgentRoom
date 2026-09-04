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
		err := openClientEntry(platform, "https://team.example", "https://team.example", proof, func(name string, args ...string) error {
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
		if err := openClientEntry("darwin", origin, origin, proof, func(string, ...string) error { t.Fatal("opened invalid origin"); return nil }); err == nil {
			t.Fatal("accepted unsafe origin")
		}
	}
	err := openClientEntry("darwin", "http://127.0.0.1:3000", "http://127.0.0.1:3000", proof, func(string, ...string) error { return errors.New(proof) })
	if err == nil || strings.Contains(err.Error(), proof) {
		t.Fatal("browser failure disclosed proof")
	}
}

func TestClientEntryAllowsOnlyAuthenticatedSameHostLANBrowserOrigin(t *testing.T) {
	proof := strings.Repeat("t", 43)
	called := false
	err := openClientEntry("windows", "https://central.local:40000", "http://central.local:40080", proof,
		func(_ string, args ...string) error {
			called = true
			if args[len(args)-1] != "http://central.local:40080/#clientEntry="+proof {
				t.Fatalf("unexpected LAN browser target: %q", args[len(args)-1])
			}
			return nil
		})
	if err != nil || !called {
		t.Fatalf("same-host LAN browser target was rejected: %v", err)
	}
	for _, browserOrigin := range []string{
		"http://other.local:40080",
		"http://user@central.local:40080",
		"http://central.local:40080/path",
		"http://central.local:40080?next=evil",
		"ftp://central.local:40080",
		"https://central.local:4443",
	} {
		if err := openClientEntry("windows", "https://central.local:40000", browserOrigin, proof,
			func(string, ...string) error { t.Fatal("opened unbound browser origin"); return nil }); err == nil {
			t.Fatalf("accepted unbound browser origin %q", browserOrigin)
		}
	}
}

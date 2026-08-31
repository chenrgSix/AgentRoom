package pairing

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestMemberPairingNegotiatesIndependentProofAndRejectsDowngrade(t *testing.T) {
	for _, tc := range []struct {
		name               string
		requested, enabled bool
	}{
		{"member", true, true}, {"downgrade", true, false}, {"unsolicited", false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var key, poll string
			expiry := time.Now().UTC().Add(time.Minute).Format(time.RFC3339)
			central := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
					return
				}
				if strings.HasSuffix(r.URL.Path, "/claim") {
					key, _ = body["clientAccessSecret"].(string)
					poll, _ = body["pollSecret"].(string)
					if tc.requested && (!validPairingSecret(key) || key == poll || key == body["claimSecret"]) {
						t.Error("human proof is not independent")
					}
					if !tc.requested && key != "" {
						t.Error("legacy pairing received human proof")
					}
					writePairingJSON(t, w, map[string]any{"pairingSessionId": "pairing_member123", "pairingAttemptId": body["pairingAttemptId"], "state": "claimed", "verificationPhrase": "VIOLET-RIVER-42", "expiresAt": expiry, "pollIntervalMs": 500})
					return
				}
				result := map[string]any{"pairingSessionId": "pairing_member123", "pairingAttemptId": body["pairingAttemptId"], "state": "consumed", "credentialSource": "poll_secret", "deviceId": "device_member123", "teamId": "team_member123", "ownerMemberId": "member_person123"}
				if tc.enabled {
					result["clientAccessEnabled"] = true
				}
				writePairingJSON(t, w, result)
			}))
			defer central.Close()
			link := "convenewire://pair-device?" + url.Values{"origin": {central.URL}, "pairingSessionId": {"pairing_member123"}, "expiresAt": {expiry}}.Encode() + "#claimSecret=" + strings.Repeat("c", 43)
			if tc.requested {
				link += "&memberAccess=1"
			}
			credential, err := (SessionClient{RetryDelay: time.Millisecond}).Pair(context.Background(), validPairingConfig(central.URL), SessionInput{Link: link}, nil)
			if tc.requested != tc.enabled {
				if err == nil {
					t.Fatal("accepted inconsistent member access negotiation")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if credential.ClientAccessSecret != key || credential.Token != poll {
				t.Fatal("wrong credential projection")
			}
			for _, suffix := range []string{"&memberAccess=1", "&memberAccess=0"} {
				if _, err := ParseSessionLink(link + suffix); err == nil {
					t.Fatal("accepted ambiguous member access marker")
				}
			}
		})
	}
}

func TestClientMemberProofPersistsSeparatelyAndRejectsMismatchedFiles(t *testing.T) {
	directory := t.TempDir()
	credential := Credential{ServerURL: "https://team.example", DeviceID: "device_member123", TeamID: "team_member123", OwnerMemberID: "member_person123", Token: strings.Repeat("d", 43), ClientAccessSecret: strings.Repeat("h", 43)}
	if err := Save(directory, credential); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(directory)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.ClientAccessSecret != "" {
		t.Fatal("Runtime credential contains human proof")
	}
	serialized, _ := json.Marshal(credential)
	if bytes.Contains(serialized, []byte(credential.ClientAccessSecret)) {
		t.Fatal("human proof serialized into Device credential")
	}
	key, err := LoadClientAccess(directory, loaded)
	if err != nil || key != credential.ClientAccessSecret {
		t.Fatal("could not recover separate member proof", err)
	}
	for _, change := range []func(*Credential){
		func(c *Credential) { c.ServerURL = "https://other.example" },
		func(c *Credential) { c.DeviceID = "device_other123" },
		func(c *Credential) { c.TeamID = "team_other123" },
		func(c *Credential) { c.OwnerMemberID = "member_other123" },
		func(c *Credential) { c.Token = key },
	} {
		changed := loaded
		change(&changed)
		if _, err := LoadClientAccess(directory, changed); err == nil {
			t.Fatal("accepted mismatched member proof")
		}
	}
	if err := saveClientAccess(directory, credential); err == nil {
		t.Fatal("overwrote existing proof")
	}
	file := filepath.Join(directory, clientAccessFilename)
	if runtime.GOOS != "windows" {
		if err := os.Chmod(file, 0644); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadClientAccess(directory, loaded); err == nil {
			t.Fatal("accepted world-readable member proof")
		}
		if err := os.Chmod(file, 0600); err != nil {
			t.Fatal(err)
		}
		moved := filepath.Join(directory, "moved.json")
		if err := os.Rename(file, moved); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(moved, file); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadClientAccess(directory, loaded); err == nil {
			t.Fatal("accepted symlink member proof")
		}
	}
}

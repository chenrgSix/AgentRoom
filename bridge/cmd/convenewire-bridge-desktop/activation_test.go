//go:build desktop

package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/console"
	"convenewire.dev/bridge/internal/enrollment"
	"convenewire.dev/bridge/internal/operations"
	"convenewire.dev/bridge/internal/pairing"
	"github.com/wailsapp/wails/v3/pkg/application"
)

func activationTestConsole(root string) (*console.Service, error) {
	return console.New(console.Options{ConfigPath: filepath.Join(root, "bridge.json"), DataDir: filepath.Join(root, "data"), Workspace: root}, console.Dependencies{
		DiscoverRuntime: func(string) console.RuntimeDiscovery { return console.RuntimeDiscovery{} },
		Enroll: func(context.Context, config.Config, func(enrollment.Challenge)) (pairing.Credential, error) {
			return pairing.Credential{}, errors.New("native activation fixture must not enroll")
		},
		SaveConfig: func(string, config.Config) error { return errors.New("native activation fixture must not save config") },
		ReplaceConfig: func(string, config.Config) error {
			return errors.New("native activation fixture must not replace config")
		},
		SaveCredential: func(string, pairing.Credential) error {
			return errors.New("native activation fixture must not save credentials")
		},
		RunBridge: func(context.Context, config.Config, pairing.Credential, operations.Observer) error {
			return errors.New("native activation fixture must not start a worker")
		},
	})
}

func TestNativeActivationConsoleFixtureOwnsOnlyTemporaryState(t *testing.T) {
	root := t.TempDir()
	service, err := activationTestConsole(root)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	if other, err := activationTestConsole(root); err == nil {
		other.Close()
		t.Fatal("native fixture failed to hold actual Console ownership")
	}
	service.Close()
	other, err := activationTestConsole(root)
	if err != nil {
		t.Fatal("fixture Console did not release ownership", err)
	}
	other.Close()
}

func testActivationLink() string {
	return "convenewire://pair-device?origin=https%3A%2F%2Fteam.example&pairingSessionId=pairing_12345678&expiresAt=2026-08-28T12%3A00%3A00Z#claimSecret=" + strings.Repeat("s", 43)
}

func TestActivationCodecPreservesOnlyValidatedIntent(t *testing.T) {
	link := testActivationLink()
	https := "https://team.example/device-pairing?pairingSessionId=pairing_12345678&expiresAt=2026-08-28T12%3A00%3A00Z#claimSecret=" + strings.Repeat("s", 43)
	for _, input := range []string{"", link, strings.Replace(link, "convenewire:", "agentroom:", 1), https, strings.Replace(https, "https://team.example", "http://127.0.0.1:3000", 1)} {
		encoded, err := encodeActivation(input)
		if err != nil {
			t.Fatal("encode failed", err)
		}
		decoded, err := decodeActivation(encoded)
		if err != nil || decoded != input {
			t.Fatal("validated intent did not round trip", err)
		}
		if strings.Contains(encoded, "claimSecret") || strings.Contains(encoded, "team.example") {
			t.Fatal("activation envelope contains plaintext pairing data")
		}
	}
	for _, args := range [][]string{
		{"desktop", "--pairing-link=" + https}, {"desktop", "--pairing-link", https},
		{"desktop", "-pairing-link=" + https}, {"desktop", "-pairing-link", https},
	} {
		got, err := activationLink(application.SecondInstanceData{Args: args})
		if err != nil || got != https {
			t.Fatal("raw Wails explicit pairing flag was lost", err)
		}
	}
}

func TestActivationCodecAcceptsContractLengthPrivateCALink(t *testing.T) {
	// Both origin copies expand to percent-encoded bytes in the canonical link.
	// These field lengths are contract-valid even though this test never contacts
	// the synthetic host or bootstraps its trust descriptor.
	origin := "https://" + strings.Repeat("!", 2040)
	query := url.Values{
		"origin": {origin}, "pairingSessionId": {"pairing_" + strings.Repeat("s", 128)},
		"expiresAt": {"2026-08-31T12:00:00.123456789Z"},
	}
	fragment := url.Values{
		"claimSecret": {strings.Repeat("c", 128)}, "trustMode": {"private_scoped_ca"},
		"trustOrigin": {origin}, "installationId": {"install_" + strings.Repeat("i", 128)},
		"trustEpoch": {"2147483647"}, "caCertificateSha256": {strings.Repeat("a", 64)},
	}
	link := "convenewire://pair-device?" + query.Encode() + "#" + fragment.Encode()
	if len(link) <= 8192 || len(link) > maxPairingLinkBytes {
		t.Fatalf("fixture did not exercise encoded link expansion: %d bytes", len(link))
	}
	encoded, err := encodeActivation(link)
	if err != nil {
		t.Fatal("contract-length private trust link rejected", err)
	}
	decoded, err := decodeActivation(encoded)
	if err != nil || decoded != link {
		t.Fatal("contract-length private trust link did not round trip", err)
	}
}

func TestActivationCodecRejectsMalformedOrUnboundedInputWithoutProofInErrors(t *testing.T) {
	encoded, err := encodeActivation(testActivationLink())
	if err != nil {
		t.Fatal(err)
	}
	sealed, _ := base64.StdEncoding.DecodeString(encoded)
	sealed[len(sealed)-1] ^= 1
	badJSON := []string{
		`{"args":[],"unexpected":"value"}`, `{"args":["convenewire://unexpected#claimSecret=do-not-log"]}`,
		`{"args":[]} {"args":[]}`, `{"args":"wrong"}`, `not json`,
	}
	invalid := []string{"", "!not-base64", strings.Repeat("a", maxActivationEncodedBytes+1), base64.StdEncoding.EncodeToString(sealed)}
	for _, plaintext := range badJSON {
		ciphertext, err := encryptActivation([]byte(plaintext))
		if err != nil {
			t.Fatal(err)
		}
		invalid = append(invalid, ciphertext)
	}
	for _, input := range invalid {
		if _, err := decodeActivation(input); err == nil || strings.Contains(err.Error(), "do-not-log") {
			t.Fatal("invalid envelope accepted or error leaked pairing proof")
		}
	}
	for _, data := range []application.SecondInstanceData{
		{Args: make([]string, 33)}, {WorkingDir: strings.Repeat("d", 4097)},
		{Args: []string{strings.Repeat("a", maxPairingLinkBytes+1)}},
		{AdditionalData: map[string]string{"a": strings.Repeat("a", maxActivationPlaintext+1)}},
		{Args: []string{"--pairing-link"}},
		{Args: []string{"--pairing-link=" + testActivationLink(), "--pairing-link=" + testActivationLink()}},
		{Args: []string{"--pairing-link", testActivationLink(), testActivationLink()}},
	} {
		if _, err := activationLink(data); err == nil {
			t.Fatal("invalid activation arguments accepted")
		}
	}
}

func TestActivationQueuesPairingBeforeReadyAndWakeCannotEraseIt(t *testing.T) {
	var activation desktopActivation
	var queued []func()
	var delivered []string
	if !activation.accept(testActivationLink()) || !activation.accept("") {
		t.Fatal("early intents rejected")
	}
	activation.ready(nil, func(string) { t.Fatal("invalid ready used") })
	activation.ready(func(fn func()) { t.Fatal("invalid ready dispatched") }, nil)
	activation.ready(func(fn func()) { queued = append(queued, fn) }, func(link string) { delivered = append(delivered, link) })
	if len(queued) != 1 || len(delivered) != 0 {
		t.Fatal("intent was not confined to the main-thread dispatcher")
	}
	queued[0]()
	if !reflect.DeepEqual(delivered, []string{testActivationLink()}) {
		t.Fatal("wake replaced pending pairing")
	}
	activation.accept("")
	activation.close() // Wails OnShutdown is on the same UI thread as drain.
	queued[1]()
	if len(delivered) != 1 || activation.accept(testActivationLink()) {
		t.Fatal("shutdown did not discard pending activation")
	}
}

func TestActivationDeliveryAllowsNativeReentryAndShutdown(t *testing.T) {
	var activation desktopActivation
	deliveries := 0
	activation.ready(func(fn func()) { fn() }, func(link string) {
		deliveries++
		if deliveries == 1 {
			if !activation.accept("") {
				t.Fatal("reentrant wake rejected")
			}
		} else {
			activation.close()
		}
	})
	activation.accept(testActivationLink())
	if deliveries != 2 || activation.accept("") {
		t.Fatal("reentrant delivery or shutdown failed")
	}
}

func TestActivationRejectsConflictingPairingUntilPendingIntentDispatched(t *testing.T) {
	var activation desktopActivation
	defer activation.close()
	first := testActivationLink()
	second := strings.Replace(first, "pairing_12345678", "pairing_87654321", 1)
	var queued []func()
	var delivered []string
	if !activation.accept(first) || activation.accept(second) ||
		!activation.accept(first) || !activation.accept("") {
		t.Fatal("pending admission did not preserve the acknowledged pairing")
	}
	activation.ready(func(fn func()) { queued = append(queued, fn) }, func(link string) {
		delivered = append(delivered, link)
	})
	if len(queued) != 1 {
		t.Fatal("duplicate pairing or wake added a second pending dispatch")
	}
	queued[0]()
	if !reflect.DeepEqual(delivered, []string{first}) || !activation.accept(second) || len(queued) != 2 {
		t.Fatal("draining the first pairing did not permit a subsequent pairing")
	}
	queued[1]()
	if !reflect.DeepEqual(delivered, []string{first, second}) {
		t.Fatal("pairing dispatch order changed")
	}
}

func TestActivationInitialPairingSharesAdmissionBeforeReceiverStartup(t *testing.T) {
	first := testActivationLink()
	second := strings.Replace(first, "pairing_12345678", "pairing_87654321", 1)
	activation, err := newDesktopActivation(first)
	if err != nil {
		t.Fatal(err)
	}
	defer activation.close()
	if activation.accept(second) || !activation.accept(first) || !activation.accept("") {
		t.Fatal("initial pairing was not protected from subsequent startup activation")
	}
	var queued []func()
	var delivered []string
	activation.ready(func(fn func()) { queued = append(queued, fn) }, func(link string) {
		delivered = append(delivered, link)
	})
	if len(queued) != 1 || len(delivered) != 0 {
		t.Fatal("initial pairing bypassed the main-thread activation queue")
	}
	queued[0]()
	if !reflect.DeepEqual(delivered, []string{first}) {
		t.Fatal("initial pairing changed or was delivered twice")
	}
}

func TestActivationInitialEmptyAndInvalidLinksDoNotBecomeWakes(t *testing.T) {
	activation, err := newDesktopActivation("")
	if err != nil {
		t.Fatal(err)
	}
	defer activation.close()
	activation.ready(func(func()) { t.Fatal("ordinary launch scheduled a wake") }, func(string) {
		t.Fatal("ordinary launch forced a background window open")
	})
	if invalid, err := newDesktopActivation("convenewire://invalid#claimSecret=private"); invalid != nil || !errors.Is(err, errInvalidActivation) {
		t.Fatal("malformed initial pairing did not fail closed")
	}
}

func TestActivationConcurrentStartupUsesOneQueuedDrain(t *testing.T) {
	var activation desktopActivation
	var queuedMu sync.Mutex
	var queued []func()
	var group sync.WaitGroup
	for index := 0; index < 64; index++ {
		group.Add(1)
		go func() { defer group.Done(); activation.accept("") }()
	}
	delivered := ""
	activation.ready(func(fn func()) { queuedMu.Lock(); queued = append(queued, fn); queuedMu.Unlock() }, func(link string) { delivered = link })
	activation.accept(testActivationLink())
	group.Wait()
	if len(queued) != 1 {
		t.Fatalf("got %d queued drains", len(queued))
	}
	queued[0]()
	if delivered != testActivationLink() {
		t.Fatal("concurrent wakes erased pairing")
	}
	activation.close()
}

func TestDesktopLeaseCoversPrimaryCloseAndAllFailures(t *testing.T) {
	for _, test := range []struct {
		name                                  string
		forwarded, acquireError, primaryError bool
	}{
		{name: "primary"}, {name: "primary failure", primaryError: true},
		{name: "secondary", forwarded: true}, {name: "arbitration failure", acquireError: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			var order []string
			failure := errors.New("test failure")
			err := runWithDesktopInstance(func() (*desktopInstance, error) {
				instance := &desktopInstance{forwarded: test.forwarded, release: func() { order = append(order, "release") }}
				if test.acquireError {
					return instance, failure
				}
				return instance, nil
			}, func(*desktopInstance) error {
				order = append(order, "console open")
				defer func() { order = append(order, "console closed") }()
				if test.primaryError {
					return failure
				}
				return nil
			})
			want := []string{"release"}
			if !test.forwarded && !test.acquireError {
				want = []string{"console open", "console closed", "release"}
			}
			if !reflect.DeepEqual(order, want) || ((err != nil) != (test.primaryError || test.acquireError)) {
				t.Fatalf("ownership order: %v, error: %v", order, err)
			}
		})
	}
}

func TestDesktopArbitratesBeforeOpeningConsole(t *testing.T) {
	// Guard the composition boundary too: testing the coordinator alone would
	// miss moving Console.New back before Wails macOS/Linux arbitration.
	source, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	applicationIndex := bytes.Index(source, []byte("app := application.New("))
	consoleIndex := bytes.Index(source, []byte("service, err = console.New("))
	if applicationIndex < 0 || consoleIndex < applicationIndex {
		t.Fatal("Console must not open before Wails instance arbitration")
	}
}

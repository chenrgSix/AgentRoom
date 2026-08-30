//go:build desktop

package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
)

const (
	desktopInstanceID  = "dev.agentroom.bridge.desktop"
	desktopWindowClass = "dev.agentroom.bridge.desktop.window.v1"
	// A contract-valid 2048-byte origin can expand in both origin and the
	// private-CA trustOrigin fragment. Bound the encoded link, not a PEM size.
	maxPairingLinkBytes       = 16 * 1024
	maxActivationPlaintext    = 32 * 1024
	maxActivationEncodedBytes = 48 * 1024
)

// Preserve the released Wails activation envelope/key for forwarding to a
// previous desktop process. Neither a pairing proof nor this envelope is saved.
var desktopInstanceKey = sha256.Sum256([]byte("agentroom.dev.bridge.desktop.instance.v1"))

var errInvalidActivation = errors.New("invalid desktop activation")

type desktopInstance struct {
	forwarded      bool
	release        func()
	singleInstance *application.SingleInstanceOptions
	windows        application.WindowsOptions
}

func runWithDesktopInstance(acquire func() (*desktopInstance, error), primary func(*desktopInstance) error) error {
	instance, err := acquire()
	if instance != nil && instance.release != nil {
		defer instance.release()
	}
	if err != nil {
		return err
	}
	if instance == nil {
		return errors.New("desktop instance arbitration returned no owner")
	}
	if instance.forwarded {
		return nil
	}
	// The native instance lease outlives every primary defer, including the
	// Console's worker drain and release of its independent data-directory lock.
	return primary(instance)
}

// desktopActivation owns only bounded UI intent, never a Console or worker.
// A wake cannot erase a pairing link accepted before the main thread is ready.
type desktopActivation struct {
	mu        sync.Mutex
	pending   bool
	link      string
	scheduled bool
	closed    bool
	dispatch  func(func())
	deliver   func(string)
}

func (a *desktopActivation) accept(link string) bool {
	validated, err := pairingLinkFromLaunch(link, nil)
	if err != nil {
		return false
	}
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return false
	}
	if validated != "" && a.link != "" && a.link != validated {
		// A previously acknowledged pairing intent must not be replaced while
		// waiting for the UI. Its exact duplicate and ordinary wakes may coalesce.
		a.mu.Unlock()
		return false
	}
	a.pending = true
	if validated != "" {
		a.link = validated
	}
	dispatch := a.scheduleLocked()
	a.mu.Unlock()
	if dispatch != nil {
		dispatch(a.drain)
	}
	return true
}

func (a *desktopActivation) ready(dispatch func(func()), deliver func(string)) {
	if dispatch == nil || deliver == nil {
		return
	}
	a.mu.Lock()
	if a.closed || a.dispatch != nil {
		a.mu.Unlock()
		return
	}
	a.dispatch, a.deliver = dispatch, deliver
	next := a.scheduleLocked()
	a.mu.Unlock()
	if next != nil {
		next(a.drain)
	}
}

func (a *desktopActivation) scheduleLocked() func(func()) {
	if a.dispatch == nil || !a.pending || a.scheduled {
		return nil
	}
	a.scheduled = true
	return a.dispatch
}

func (a *desktopActivation) drain() {
	a.mu.Lock()
	a.scheduled = false
	if a.closed || !a.pending {
		a.mu.Unlock()
		return
	}
	link, deliver := a.link, a.deliver
	a.link, a.pending = "", false
	a.mu.Unlock()
	// Both delivery and Wails OnShutdown run on the UI thread. Never hold this
	// lock across native UI calls: a synchronous window message can reenter accept.
	deliver(link)
}

func (a *desktopActivation) close() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.closed, a.pending = true, false
	a.link, a.deliver, a.dispatch = "", nil, nil
}

func activationLink(data application.SecondInstanceData) (string, error) {
	if len(data.Args) > 32 || len(data.WorkingDir) > 4096 || len(data.AdditionalData) > 4 {
		return "", errInvalidActivation
	}
	size := len(data.WorkingDir)
	for _, argument := range data.Args {
		size += len(argument)
	}
	for key, value := range data.AdditionalData {
		size += len(key) + len(value)
	}
	if size > maxActivationPlaintext {
		return "", errInvalidActivation
	}
	// Wails forwards raw os.Args, including explicit flags. Normalize both flag
	// forms instead of silently turning an HTTPS pairing-link launch into a wake.
	arguments := make([]string, 0, len(data.Args))
	explicit := ""
	hasExplicit := false
	for index := 0; index < len(data.Args); index++ {
		argument := data.Args[index]
		if argument == "--pairing-link" || argument == "-pairing-link" {
			if hasExplicit || index+1 == len(data.Args) {
				return "", errInvalidActivation
			}
			index++
			explicit, hasExplicit = data.Args[index], true
		} else if strings.HasPrefix(argument, "--pairing-link=") || strings.HasPrefix(argument, "-pairing-link=") {
			if hasExplicit {
				return "", errInvalidActivation
			}
			explicit, hasExplicit = strings.SplitN(argument, "=", 2)[1], true
		} else {
			arguments = append(arguments, argument)
		}
	}
	link, err := pairingLinkFromLaunch(explicit, arguments)
	if err != nil {
		return "", errInvalidActivation
	}
	return link, nil
}

func encodeActivation(link string) (string, error) {
	validated, err := pairingLinkFromLaunch(link, nil)
	if err != nil {
		return "", errInvalidActivation
	}
	data := application.SecondInstanceData{Args: []string{}}
	if validated != "" {
		// A positional custom URI keeps compatibility with released Windows
		// receivers; HTTPS links need the explicit flag understood by new receivers.
		if strings.HasPrefix(strings.ToLower(validated), "https://") || strings.HasPrefix(strings.ToLower(validated), "http://") {
			data.Args = append(data.Args, "--pairing-link", validated)
		} else {
			data.Args = append(data.Args, validated)
		}
	}
	plaintext, err := json.Marshal(data)
	if err != nil || len(plaintext) > maxActivationPlaintext {
		return "", errInvalidActivation
	}
	return encryptActivation(plaintext)
}

func activationCipher() (cipher.AEAD, error) {
	block, err := aes.NewCipher(desktopInstanceKey[:])
	if err != nil {
		return nil, errInvalidActivation
	}
	return cipher.NewGCM(block)
}

func encryptActivation(plaintext []byte) (string, error) {
	if len(plaintext) > maxActivationPlaintext {
		return "", errInvalidActivation
	}
	aead, err := activationCipher()
	if err != nil {
		return "", errInvalidActivation
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", errors.New("create desktop activation nonce")
	}
	sealed := aead.Seal(nonce, nonce, plaintext, nil)
	return base64.StdEncoding.EncodeToString(sealed), nil
}

func decodeActivation(encoded string) (string, error) {
	if len(encoded) == 0 || len(encoded) > maxActivationEncodedBytes {
		return "", errInvalidActivation
	}
	sealed, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil {
		return "", errInvalidActivation
	}
	aead, err := activationCipher()
	if err != nil || len(sealed) < aead.NonceSize()+aead.Overhead() ||
		len(sealed) > maxActivationPlaintext+aead.NonceSize()+aead.Overhead() {
		return "", errInvalidActivation
	}
	plaintext, err := aead.Open(nil, sealed[:aead.NonceSize()], sealed[aead.NonceSize():], nil)
	if err != nil {
		return "", errInvalidActivation
	}
	decoder := json.NewDecoder(bytes.NewReader(plaintext))
	decoder.DisallowUnknownFields()
	var data application.SecondInstanceData
	if err := decoder.Decode(&data); err != nil {
		return "", errInvalidActivation
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return "", errInvalidActivation
	}
	return activationLink(data)
}

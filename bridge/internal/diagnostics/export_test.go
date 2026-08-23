package diagnostics

import (
	"archive/zip"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestExportIsBoundedExclusiveAndRemovesSensitiveData(t *testing.T) {
	directory := t.TempDir()
	now := time.Date(2026, 8, 23, 12, 0, 0, 0, time.UTC)
	secret := "sk-1234567890abcdefghijklmnop"
	events := make([]Event, 105)
	for index := range events {
		events[index] = Event{
			At: now.Format(time.RFC3339Nano), Type: "connection.retrying",
			Message: "Bearer abcdefghijklmnop token=very-secret-value " + secret + " /Users/alice/private/project prompt-do-not-export reply-do-not-export",
		}
	}
	input := Input{
		Version: "v0.2.0", Configured: true, Paired: true, BridgeRunning: true,
		Connection: Connection{State: "retrying", LastError: events[0].Message},
		Agents: []Agent{{
			Kind: "codex", ExecutableReady: true, RuntimeState: "error",
			LastRuntimeError: "agent_abcdef123456 " + secret,
		}},
		Events: events, Now: now,
	}
	first, err := Export(directory, input)
	if err != nil {
		t.Fatal(err)
	}
	second, err := Export(directory, input)
	if err != nil {
		t.Fatal(err)
	}
	if first.Path == second.Path || !strings.HasSuffix(second.Filename, "-01.zip") {
		t.Fatalf("diagnostics export overwrote an archive: %#v %#v", first, second)
	}
	info, err := os.Stat(first.Path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("unexpected archive permissions: %#v, %v", info, err)
	}
	archive, err := zip.OpenReader(first.Path)
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	if len(archive.File) != 3 {
		t.Fatalf("unexpected archive entries: %d", len(archive.File))
	}
	allowed := map[string]bool{"manifest.json": true, "status.json": true, "events.json": true}
	var extracted strings.Builder
	for _, entry := range archive.File {
		if !allowed[entry.Name] {
			t.Fatalf("unexpected archive entry %q", entry.Name)
		}
		reader, err := entry.Open()
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(&extracted, reader)
		reader.Close()
	}
	text := extracted.String()
	for _, forbidden := range []string{secret, "very-secret-value", "abcdefghijklmnop", "/Users/alice", "agent_abcdef123456", "prompt-do-not-export", "reply-do-not-export"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("diagnostics contains %q: %s", forbidden, text)
		}
	}
	if strings.Count(text, "connection.retrying") != maxEvents {
		t.Fatalf("expected %d bounded events", maxEvents)
	}
	if first.SHA256 == "" || first.Filename != filepath.Base(first.Path) {
		t.Fatalf("incomplete result: %#v", first)
	}
}

func TestSanitizeCapsLongText(t *testing.T) {
	value := Sanitize(strings.Repeat("x", maxTextLength+20))
	if len(value) != maxTextLength+3 || !strings.HasSuffix(value, "...") {
		t.Fatalf("unexpected capped text length %d", len(value))
	}
}

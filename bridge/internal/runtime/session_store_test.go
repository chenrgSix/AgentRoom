package runtime

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFileRuntimeSessionStorePersistsScopedBinding(t *testing.T) {
	dataDir := t.TempDir()
	store := NewFileRuntimeSessionStore(dataDir)
	key := RuntimeSessionKey{
		RuntimeKind: "codex", RoomID: "room_alpha", AgentID: "agent_builder",
		Workspace: filepath.Join(dataDir, "workspace"),
	}
	if _, found, err := store.Load(key); err != nil || found {
		t.Fatalf("unexpected empty session lookup: found=%t err=%v", found, err)
	}
	if err := store.Save(RuntimeSessionBinding{
		RuntimeSessionKey: key, SessionID: "thread_alpha",
	}); err != nil {
		t.Fatal(err)
	}
	binding, found, err := store.Load(key)
	if err != nil || !found || binding.SessionID != "thread_alpha" {
		t.Fatalf("unexpected persisted session: %#v found=%t err=%v", binding, found, err)
	}
	path, err := store.bindingPath(key)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("Runtime session binding permissions are %o", info.Mode().Perm())
	}
	directoryInfo, err := os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if directoryInfo.Mode().Perm() != 0o700 {
		t.Fatalf("Runtime session directory permissions are %o", directoryInfo.Mode().Perm())
	}
	other := key
	other.RoomID = "room_beta"
	if _, found, err := store.Load(other); err != nil || found {
		t.Fatalf("Runtime session crossed Room scope: found=%t err=%v", found, err)
	}
	if err := store.Delete(key); err != nil {
		t.Fatal(err)
	}
	if _, found, err := store.Load(key); err != nil || found {
		t.Fatalf("deleted session remained visible: found=%t err=%v", found, err)
	}
}

func TestFileRuntimeSessionStoreRejectsTamperedBinding(t *testing.T) {
	store := NewFileRuntimeSessionStore(t.TempDir())
	key := RuntimeSessionKey{
		RuntimeKind: "codex", RoomID: "room_alpha", AgentID: "agent_builder",
		Workspace: t.TempDir(),
	}
	path, err := store.bindingPath(key)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"runtimeKind":"codex","roomId":"room_other","agentId":"agent_builder","workspace":"/tmp/workspace","sessionId":"thread_wrong"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Load(key); err == nil {
		t.Fatal("tampered Runtime session binding was accepted")
	}
}

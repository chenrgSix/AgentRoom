package launchable

import (
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestWindowsLauncherPolicyUsesExtensionsInsteadOfUnixExecuteBits(t *testing.T) {
	for _, extension := range []string{".exe", ".COM", ".bat", ".CMD"} {
		if !fileModeAllowed("codex"+extension, 0o600, "windows") {
			t.Fatalf("Windows launcher %s required Unix execute bits", extension)
		}
	}
	for _, path := range []string{"codex", "codex.ps1", "codex.sh"} {
		if fileModeAllowed(path, 0o700, "windows") {
			t.Fatalf("unsupported Windows launcher was accepted: %s", path)
		}
	}
	if fileModeAllowed("codex.cmd", fs.ModeDir|0o700, "windows") {
		t.Fatal("Windows directory was accepted as a launcher")
	}
}

func TestUnixLauncherPolicyRetainsExecuteBitRequirement(t *testing.T) {
	if fileModeAllowed("codex", 0o600, "linux") {
		t.Fatal("Unix launcher without execute bits was accepted")
	}
	if !fileModeAllowed("codex.cmd", 0o700, "darwin") {
		t.Fatal("Unix executable was rejected based on its extension")
	}
}

func TestWindowsLauncherFilenamesAreBounded(t *testing.T) {
	want := []string{"codex.exe", "codex.com", "codex.bat", "codex.cmd"}
	if got := Filenames("codex", "windows"); !reflect.DeepEqual(got, want) {
		t.Fatalf("Windows launcher filenames = %#v, want %#v", got, want)
	}
	if got := Filenames("codex", "linux"); !reflect.DeepEqual(got, []string{"codex"}) {
		t.Fatalf("Unix launcher filenames = %#v", got)
	}
}

func TestWindowsLauncherFileMustBeRegular(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "codex.cmd")
	if err := os.WriteFile(path, []byte("@exit /b 0\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if !File(path, "windows") {
		t.Fatal("regular Windows command shim was rejected")
	}
	if File(directory, "windows") {
		t.Fatal("directory was accepted as a Windows launcher")
	}
}

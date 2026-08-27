package launchable

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

var windowsExecutableExtensions = []string{".exe", ".com", ".bat", ".cmd"}

// File reports whether path identifies a regular file that the target platform
// can launch directly through os/exec. Windows does not expose Unix execute
// permission bits, so its bounded launcher extensions are authoritative.
func File(path, platform string) bool {
	info, err := os.Stat(path)
	return err == nil && fileModeAllowed(path, info.Mode(), platform)
}

// Filenames returns the bounded filenames used when probing known installation
// directories. PATH discovery remains delegated to exec.LookPath.
func Filenames(name, platform string) []string {
	if platform != "windows" {
		return []string{name}
	}
	result := make([]string, 0, len(windowsExecutableExtensions))
	for _, extension := range windowsExecutableExtensions {
		result = append(result, name+extension)
	}
	return result
}

func fileModeAllowed(path string, mode fs.FileMode, platform string) bool {
	if !mode.IsRegular() {
		return false
	}
	if platform == "windows" {
		extension := strings.ToLower(filepath.Ext(path))
		for _, allowed := range windowsExecutableExtensions {
			if extension == allowed {
				return true
			}
		}
		return false
	}
	return mode.Perm()&0o111 != 0
}

//go:build desktop

package main

import (
	"bytes"
	"testing"

	"convenewire.dev/bridge/internal/desktopicons"
	"github.com/wailsapp/wails/v3/pkg/icons"
)

func TestWindowsShellUsesTheProductIconWithoutChangingOtherPlatforms(t *testing.T) {
	if !bytes.Equal(desktopApplicationIcon("windows"), desktopicons.Windows) ||
		!bytes.Equal(desktopTrayIcon("windows"), desktopicons.Windows) {
		t.Fatal("Windows window and tray must use the packaged product mark")
	}
	for _, platform := range []string{"darwin", "linux"} {
		if !bytes.Equal(desktopApplicationIcon(platform), icons.ApplicationLightMode256) ||
			!bytes.Equal(desktopTrayIcon(platform), icons.SystrayLight) {
			t.Fatalf("Windows icon repair changed %s defaults", platform)
		}
	}
}

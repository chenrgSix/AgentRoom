//go:build desktop

package main

import (
	"convenewire.dev/bridge/internal/desktopicons"
	"github.com/wailsapp/wails/v3/pkg/icons"
)

func desktopApplicationIcon(goos string) []byte {
	if goos == "windows" {
		return desktopicons.Windows
	}
	return icons.ApplicationLightMode256
}

func desktopTrayIcon(goos string) []byte {
	if goos == "windows" {
		return desktopicons.Windows
	}
	return icons.SystrayLight
}

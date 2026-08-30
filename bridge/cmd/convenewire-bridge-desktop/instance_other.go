//go:build desktop && !windows

package main

import "github.com/wailsapp/wails/v3/pkg/application"

func acquireDesktopInstance(_ string, activation *desktopActivation) (*desktopInstance, error) {
	// Wails arbitrates in application.New, before the primary creates a Console.
	// Preserve macOS Apple-event URL capture and Linux session-bus behaviour.
	// The pending queue protects only events delivered by Wails. In particular,
	// macOS installs its notification listener in Run, not New; that SDK startup
	// gap has no delivery handshake and is not a simultaneous-launch guarantee.
	return &desktopInstance{
		singleInstance: &application.SingleInstanceOptions{
			UniqueID: desktopInstanceID, EncryptionKey: desktopInstanceKey,
			OnSecondInstanceLaunch: func(data application.SecondInstanceData) {
				if link, err := activationLink(data); err == nil {
					activation.accept(link)
				}
			},
		},
	}, nil
}

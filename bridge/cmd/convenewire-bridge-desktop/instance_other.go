//go:build desktop && !windows && !darwin

package main

import "github.com/wailsapp/wails/v3/pkg/application"

func acquireDesktopInstance(_ string, activation *desktopActivation) (*desktopInstance, error) {
	// Preserve the remaining platforms' Wails session-bus behaviour. Darwin and
	// Windows arbitrate before Console construction using their own transport.
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

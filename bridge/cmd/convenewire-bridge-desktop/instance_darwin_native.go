//go:build desktop && darwin

package main

/*
#cgo CFLAGS: -x objective-c -fblocks
#cgo LDFLAGS: -framework Cocoa -framework CoreServices
#include <stdlib.h>
#include "instance_darwin_native.h"
*/
import "C"

import (
	"errors"
	"time"
	"unsafe"
)

func darwinNativeTempDirectory() (string, error) {
	path := C.CWDesktopTemporaryDirectory()
	if path == nil {
		return "", errors.New("resolve macOS desktop activation directory")
	}
	defer C.free(unsafe.Pointer(path))
	return C.GoString(path), nil
}

func captureDarwinLaunchURL(timeout time.Duration) (string, error) {
	if timeout <= 0 || timeout > 5*time.Second {
		return "", errors.New("invalid macOS URL capture timeout")
	}
	var captured *C.char
	status := C.CWDesktopCaptureLaunchURL(C.double(timeout.Seconds()), C.size_t(maxPairingLinkBytes), &captured)
	if captured != nil {
		defer C.free(unsafe.Pointer(captured))
	}
	if status < 0 {
		return "", errors.New("macOS URL activation capture failed")
	}
	if status == 0 {
		return "", nil
	}
	link, err := pairingLinkFromLaunch(C.GoString(captured), nil)
	if err != nil {
		return "", errInvalidActivation
	}
	return link, nil
}

// Used only by native regression subprocesses: enqueue a real kAEGetURL event
// addressed to this process, not another application or a registered protocol.
// No LaunchServices registration or third-party Automation permission is used.
func queueDarwinSelfURL(link string, delay time.Duration) error {
	if len(link) > maxPairingLinkBytes+1 || delay < 0 || delay > time.Second {
		return errInvalidActivation
	}
	value := C.CString(link)
	defer C.free(unsafe.Pointer(value))
	if C.CWDesktopQueueSelfURL(value, C.double(delay.Seconds())) != 0 {
		return errors.New("enqueue native desktop activation fixture")
	}
	return nil
}

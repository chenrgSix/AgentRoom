//go:build desktop && windows

package main

import (
	"context"
	"errors"
	"runtime"
	"strings"
	"sync"
	"time"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
	"golang.org/x/sys/windows"
)

const (
	desktopMutexName       = "wails-app-" + desktopInstanceID + "-sim"
	windowsCopyData        = 74
	activationCopyDataKind = 1542 // Released Wails beta.12 single-instance envelope.
	activationStartupWait  = 5 * time.Second
	activationSendWait     = time.Second
)

var (
	desktopUser32     = windows.NewLazySystemDLL("user32.dll")
	findDesktopWindow = desktopUser32.NewProc("FindWindowExW")
	sendDesktopData   = desktopUser32.NewProc("SendMessageTimeoutW")
	windowProcessID   = desktopUser32.NewProc("GetWindowThreadProcessId")
)

type activationCopyData struct {
	kind uintptr
	size uint32
	data uintptr
}

type activationWindow struct {
	handle uintptr
	legacy bool
}

func acquireDesktopInstance(link string, activation *desktopActivation) (*desktopInstance, error) {
	return acquireWindowsInstance(desktopMutexName, link, activation,
		func(name string) (windows.Handle, error) {
			return windows.CreateMutex(nil, false, windows.StringToUTF16Ptr(name))
		}, windows.CloseHandle, forwardWindowsActivation)
}

func acquireWindowsInstance(name, link string, activation *desktopActivation,
	create func(string) (windows.Handle, error), closeHandle func(windows.Handle) error,
	forward func(string) error,
) (*desktopInstance, error) {
	handle, err := create(name)
	var once sync.Once
	release := func() {
		once.Do(func() {
			if handle != 0 {
				_ = closeHandle(handle)
			}
		})
	}
	if err != nil && !errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		release()
		return nil, errors.New("acquire desktop instance mutex")
	}
	if handle == 0 {
		return nil, errors.New("desktop instance mutex returned no handle")
	}
	if errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		defer release()
		if err := forward(link); err != nil {
			return nil, err
		}
		return &desktopInstance{forwarded: true}, nil
	}
	return &desktopInstance{
		release: release,
		// Avoid reacquiring our own mutex and the dependency's FindWindowW /
		// HWND_MESSAGE mismatch. These are public Wails integration points.
		windows: application.WindowsOptions{
			WndClass: desktopWindowClass,
			WndProcInterceptor: func(_ uintptr, message uint32, _, lParam uintptr) (uintptr, bool) {
				return receiveWindowsActivation(message, lParam, activation)
			},
		},
	}, nil
}

func receiveWindowsActivation(message uint32, lParam uintptr, activation *desktopActivation) (uintptr, bool) {
	if message != windowsCopyData || lParam == 0 {
		return 0, false
	}
	// WM_COPYDATA is marshalled into this process for the duration of the call.
	// Copy the fixed header through the OS rather than dereferencing an arbitrary
	// uintptr. ReadProcessMemory is deliberately restricted to CurrentProcess;
	// unreadable pointers fail closed without unsafe callback-pointer conversions.
	var data activationCopyData
	var copied uintptr
	if err := windows.ReadProcessMemory(windows.CurrentProcess(), lParam,
		(*byte)(unsafe.Pointer(&data)), unsafe.Sizeof(data), &copied); err != nil || copied != unsafe.Sizeof(data) {
		return 0, true
	}
	if data.kind != activationCopyDataKind {
		return 0, false
	}
	if data.data == 0 || data.size < 2 || data.size%2 != 0 || data.size > (maxActivationEncodedBytes+1)*2 {
		return 0, true
	}
	units := make([]uint16, int(data.size/2))
	if err := windows.ReadProcessMemory(windows.CurrentProcess(), data.data,
		(*byte)(unsafe.Pointer(&units[0])), uintptr(data.size), &copied); err != nil || copied != uintptr(data.size) {
		return 0, true
	}
	if units[len(units)-1] != 0 {
		return 0, true
	}
	encoded := make([]byte, len(units)-1)
	for index, unit := range units[:len(units)-1] {
		if unit == 0 || unit > 127 {
			return 0, true
		}
		encoded[index] = byte(unit)
	}
	link, err := decodeActivation(string(encoded))
	if err != nil || !activation.accept(link) {
		return 0, true
	}
	return 1, true
}

func forwardWindowsActivation(link string) error {
	encoded, err := encodeActivation(link)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), activationStartupWait)
	defer cancel()
	return waitForActivationWindow(ctx, encoded, findActivationWindow, sendActivationToWindow)
}

func waitForActivationWindow(ctx context.Context, encoded string, find func() activationWindow,
	send func(activationWindow, string, time.Duration) error,
) error {
	for {
		if err := ctx.Err(); err != nil {
			return errors.New("existing desktop instance did not become ready for activation")
		}
		if target := find(); target.handle != 0 {
			wait := activationSendWait
			if deadline, ok := ctx.Deadline(); ok && time.Until(deadline) < wait {
				wait = time.Until(deadline)
			}
			if wait <= 0 {
				return errors.New("existing desktop instance did not become ready for activation")
			}
			// Never automatically resend an ambiguous message or start a Console.
			return send(target, encoded, wait)
		}
		select {
		case <-ctx.Done():
			return errors.New("existing desktop instance did not become ready for activation")
		case <-time.After(25 * time.Millisecond):
		}
	}
}

func findActivationWindow() activationWindow {
	return findWindowsActivationWindow(desktopWindowClass,
		"wails-app-"+desktopInstanceID+"-sic", "wails-app-"+desktopInstanceID+"-siw")
}

func findWindowsActivationWindow(className, legacyClassName, legacyWindowName string) activationWindow {
	class := windows.StringToUTF16Ptr(className)
	handle, _, _ := findDesktopWindow.Call(0, 0, uintptr(unsafe.Pointer(class)), 0)
	if handle != 0 {
		return activationWindow{handle: handle}
	}
	// New executable -> previous running beta.12 desktop. FindWindowEx must
	// explicitly search message-only windows; the old FindWindowW path cannot.
	legacyClass := windows.StringToUTF16Ptr(legacyClassName)
	legacyName := windows.StringToUTF16Ptr(legacyWindowName)
	handle, _, _ = findDesktopWindow.Call(^uintptr(2), 0, uintptr(unsafe.Pointer(legacyClass)), uintptr(unsafe.Pointer(legacyName)))
	return activationWindow{handle: handle, legacy: true}
}

func activationWindowBelongsToCurrentUser(handle uintptr) bool {
	var processID uint32
	thread, _, _ := windowProcessID.Call(handle, uintptr(unsafe.Pointer(&processID)))
	if thread == 0 || processID == 0 {
		return false
	}
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, processID)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(process)
	var token windows.Token
	if err := windows.OpenProcessToken(process, windows.TOKEN_QUERY, &token); err != nil {
		return false
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return false
	}
	current, err := windows.GetCurrentProcessToken().GetTokenUser()
	return err == nil && user.User.Sid.Equals(current.User.Sid)
}

func sendActivationToWindow(target activationWindow, encoded string, timeout time.Duration) error {
	if len(encoded) == 0 || len(encoded) > maxActivationEncodedBytes || timeout <= 0 {
		return errInvalidActivation
	}
	if target.legacy {
		link, err := decodeActivation(encoded)
		if err != nil {
			return err
		}
		if strings.HasPrefix(strings.ToLower(link), "http") {
			return errors.New("previous desktop version cannot receive this pairing link; open its pairing form or restart it")
		}
	}
	if !activationWindowBelongsToCurrentUser(target.handle) {
		return errors.New("existing desktop activation target is not owned by the current user")
	}
	units, err := windows.UTF16FromString(encoded)
	if err != nil {
		return errInvalidActivation
	}
	data := activationCopyData{kind: activationCopyDataKind, size: uint32(len(units) * 2), data: uintptr(unsafe.Pointer(&units[0]))}
	var acknowledgement uintptr
	milliseconds := max(1, int(timeout/time.Millisecond))
	result, _, _ := sendDesktopData.Call(target.handle, windowsCopyData, 0, uintptr(unsafe.Pointer(&data)),
		0x0001|0x0002, uintptr(milliseconds), uintptr(unsafe.Pointer(&acknowledgement))) // SMTO_BLOCK | SMTO_ABORTIFHUNG
	runtime.KeepAlive(units)
	runtime.KeepAlive(data)
	if result == 0 {
		return errors.New("existing desktop instance did not acknowledge activation before the timeout")
	}
	if !target.legacy && acknowledgement != 1 {
		return errors.New("existing desktop instance rejected activation")
	}
	return nil
}

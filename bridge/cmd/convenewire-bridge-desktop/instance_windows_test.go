//go:build desktop && windows

package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/w32"
	"golang.org/x/sys/windows"
)

func TestWindowsInstanceClassifiesMutexErrorsAndClosesEveryHandle(t *testing.T) {
	for _, test := range []struct {
		name                   string
		handle                 windows.Handle
		createErr, forwardErr  error
		wantForward, wantError bool
	}{
		{name: "primary", handle: 12},
		{name: "secondary", handle: 12, createErr: windows.ERROR_ALREADY_EXISTS, wantForward: true},
		{name: "forward failure", handle: 12, createErr: windows.ERROR_ALREADY_EXISTS, forwardErr: errors.New("not ready"), wantForward: true, wantError: true},
		{name: "access denied", createErr: windows.ERROR_ACCESS_DENIED, wantError: true},
		{name: "error with handle", handle: 12, createErr: windows.ERROR_ACCESS_DENIED, wantError: true},
		{name: "invalid handle", wantError: true},
		{name: "secondary invalid handle", createErr: windows.ERROR_ALREADY_EXISTS, wantError: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			closes, forwards := 0, 0
			instance, err := acquireWindowsInstance("test", "", &desktopActivation{},
				func(string) (windows.Handle, error) { return test.handle, test.createErr },
				func(handle windows.Handle) error {
					closes++
					if handle != test.handle {
						t.Fatal("wrong handle closed")
					}
					return nil
				},
				func(string) error { forwards++; return test.forwardErr })
			if (err != nil) != test.wantError || (forwards != 0) != test.wantForward {
				t.Fatalf("error %v; forwards %d", err, forwards)
			}
			if instance != nil && instance.release != nil {
				if instance.singleInstance != nil || instance.windows.WndClass != desktopWindowClass || instance.windows.WndProcInterceptor == nil {
					t.Fatal("primary must use only the public Windows activation interceptor")
				}
				if closes != 0 {
					t.Fatal("primary lease released before Console close")
				}
				instance.release()
				instance.release()
			}
			wantCloses := 0
			if test.handle != 0 {
				wantCloses = 1
			}
			if closes != wantCloses {
				t.Fatalf("closed %d handles, want %d", closes, wantCloses)
			}
		})
	}
}

func TestWindowsActivationRejectsUnboundedCopyDataBeforeReadingPointer(t *testing.T) {
	var activation desktopActivation
	var pinned runtime.Pinner
	defer pinned.Unpin()
	if ack, handled := receiveWindowsActivation(windowsCopyData, 1, &activation); ack != 0 || !handled {
		t.Fatal("unreadable copy-data header accepted")
	}
	for _, size := range []uint32{0, 1, 2, 3, (maxActivationEncodedBytes+1)*2 + 2, ^uint32(0)} {
		data := activationCopyData{kind: activationCopyDataKind, size: size, data: 1}
		pinned.Pin(&data)
		ack, handled := receiveWindowsActivation(windowsCopyData, uintptr(unsafe.Pointer(&data)), &activation)
		if ack != 0 || !handled {
			t.Fatal("invalid byte count accepted")
		}
	}
	encoded, err := encodeActivation(testActivationLink())
	if err != nil {
		t.Fatal(err)
	}
	units, _ := windows.UTF16FromString(encoded)
	data := activationCopyData{kind: activationCopyDataKind, size: uint32(len(units) * 2), data: uintptr(unsafe.Pointer(&units[0]))}
	pinned.Pin(&data)
	pinned.Pin(&units[0])
	if ack, handled := receiveWindowsActivation(windowsCopyData, uintptr(unsafe.Pointer(&data)), &activation); ack != 1 || !handled {
		t.Fatal("valid bounded activation rejected")
	}
	units[len(units)-1] = 1
	if ack, _ := receiveWindowsActivation(windowsCopyData, uintptr(unsafe.Pointer(&data)), &activation); ack != 0 {
		t.Fatal("unterminated envelope accepted")
	}
	units[len(units)-1], units[0] = 0, 0
	if ack, _ := receiveWindowsActivation(windowsCopyData, uintptr(unsafe.Pointer(&data)), &activation); ack != 0 {
		t.Fatal("embedded NUL accepted")
	}
	units[0] = 200
	if ack, _ := receiveWindowsActivation(windowsCopyData, uintptr(unsafe.Pointer(&data)), &activation); ack != 0 {
		t.Fatal("non-ASCII envelope accepted")
	}
	runtime.KeepAlive(units)
	activation.close()
}

func TestWindowsActivationWaitIsBoundedAndNeverResendsAmbiguousMessage(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	if err := waitForActivationWindow(ctx, "envelope", func() activationWindow { return activationWindow{} },
		func(activationWindow, string, time.Duration) error { t.Fatal("sent without a window"); return nil }); err == nil {
		t.Fatal("missing primary window silently succeeded")
	}
	ctx, cancel = context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	sends := 0
	failure := errors.New("ambiguous native timeout")
	err := waitForActivationWindow(ctx, "envelope", func() activationWindow { return activationWindow{handle: 1} },
		func(_ activationWindow, _ string, timeout time.Duration) error {
			sends++
			if timeout <= 0 || timeout > activationSendWait {
				t.Fatal("unbounded send")
			}
			return failure
		})
	if !errors.Is(err, failure) || sends != 1 {
		t.Fatal("ambiguous send was retried or hidden")
	}
}

// These tests execute real Windows mutex/window/message APIs in separate
// processes, without WebView2, installed owner state, or any provider calls.
// Cross-compiling this file on another OS is not Windows runtime acceptance.
func TestWindowsNativeSecondaryForwardsPairingAndWakeWithoutOpeningConsole(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		t.Run(fmt.Sprintf("legacy_%t", legacy), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			name := fmt.Sprintf("convenewire-activation-test-%d-%d", os.Getpid(), time.Now().UnixNano())
			command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestWindowsActivationHelperProcess$")
			command.Env = append(os.Environ(), "CONVENE_WIRE_ACTIVATION_HELPER="+name,
				"CONVENE_WIRE_ACTIVATION_HELPER_ROOT="+t.TempDir(), fmt.Sprintf("CONVENE_WIRE_ACTIVATION_HELPER_LEGACY=%t", legacy))
			output, err := command.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			input, err := command.StdinPipe()
			if err != nil {
				t.Fatal(err)
			}
			command.Stderr = os.Stderr
			if err := command.Start(); err != nil {
				t.Fatal(err)
			}
			exited := false
			t.Cleanup(func() {
				input.Close()
				if !exited {
					_ = command.Process.Kill()
					_ = command.Wait()
				}
			})
			lines := make(chan string, 16)
			go func() {
				defer close(lines)
				scanner := bufio.NewScanner(output)
				for scanner.Scan() {
					lines <- scanner.Text()
				}
			}()
			await := func(want string) {
				t.Helper()
				select {
				case line, ok := <-lines:
					if !ok || line != want {
						t.Fatalf("helper status %q, want %q", line, want)
					}
				case <-ctx.Done():
					t.Fatalf("native helper timed out waiting for %q", want)
				}
			}
			await("owner ready")
			find := func() activationWindow { return findWindowsActivationWindow(name, name+"-legacy", name+"-name") }
			lookupStarted := make(chan struct{}, 1)
			forward := func(link string) error {
				encoded, err := encodeActivation(link)
				if err != nil {
					return err
				}
				return waitForActivationWindow(ctx, encoded, func() activationWindow {
					select {
					case lookupStarted <- struct{}{}:
					default:
					}
					return find()
				}, sendActivationToWindow)
			}
			secondary := func(link string) error {
				return runWithDesktopInstance(func() (*desktopInstance, error) {
					return acquireWindowsInstance(name+"-mutex", link, &desktopActivation{},
						func(name string) (windows.Handle, error) {
							return windows.CreateMutex(nil, false, windows.StringToUTF16Ptr(name))
						},
						windows.CloseHandle, forward)
				}, func(*desktopInstance) error { return errors.New("secondary must not open another Console") })
			}
			forwarded := make(chan error, 1)
			go func() { forwarded <- secondary(testActivationLink()) }()
			select {
			case <-lookupStarted:
			case err := <-forwarded:
				t.Fatalf("secondary did not wait for startup: %v", err)
			case <-ctx.Done():
				t.Fatal("startup timed out")
			}
			if target := find(); target.handle != 0 {
				t.Fatal("helper window existed before startup gate")
			}
			if _, err := fmt.Fprintln(input, "create window"); err != nil {
				t.Fatal(err)
			}
			await("window ready")
			select {
			case err := <-forwarded:
				if err != nil {
					t.Fatal(err)
				}
			case <-ctx.Done():
				t.Fatal("forward timed out")
			}
			await("paired")
			if err := secondary(""); err != nil {
				t.Fatal(err)
			}
			await("wake")
			if legacy {
				https := "https://team.example/device-pairing?pairingSessionId=pairing_12345678&expiresAt=2026-08-28T12%3A00%3A00Z#claimSecret=" + strings.Repeat("s", 43)
				if err := secondary(https); err == nil {
					t.Fatal("legacy HTTPS pairing must fail explicitly, not silently become wake")
				}
			}
			target := find()
			if target.handle == 0 || target.legacy != legacy {
				t.Fatal("wrong native window discovered")
			}
			if !legacy {
				if err := sendActivationToWindow(target, "not-base64", time.Second); err == nil {
					t.Fatal("native receiver rejection silently succeeded")
				}
				if !w32.PostMessage(w32.HWND(target.handle), 0x8002, 0, 0) {
					t.Fatal("failed to pause fixture UI")
				}
				await("blocked")
				encoded, err := encodeActivation("")
				if err != nil {
					t.Fatal(err)
				}
				started := time.Now()
				if err := sendActivationToWindow(target, encoded, 50*time.Millisecond); err == nil {
					t.Fatal("unresponsive native target silently succeeded")
				}
				if time.Since(started) > time.Second {
					t.Fatal("native SendMessageTimeout exceeded its bound")
				}
				if _, err := fmt.Fprintln(input, "unblock"); err != nil {
					t.Fatal(err)
				}
			}
			if !w32.PostMessage(w32.HWND(target.handle), 0x8001, 0, 0) {
				t.Fatal("failed to stop native helper")
			}
			if err := command.Wait(); err != nil {
				t.Fatal(err)
			}
			exited = true
			handle, err := windows.CreateMutex(nil, false, windows.StringToUTF16Ptr(name+"-mutex"))
			if handle != 0 {
				defer windows.CloseHandle(handle)
			}
			if err != nil {
				t.Fatal("owner lease survived helper Console shutdown", err)
			}
		})
	}
}

func TestWindowsActivationHelperProcess(t *testing.T) {
	name := os.Getenv("CONVENE_WIRE_ACTIVATION_HELPER")
	if name == "" {
		t.Skip("subprocess-only native window fixture")
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	var activation desktopActivation
	instance, err := acquireWindowsInstance(name+"-mutex", "", &activation,
		func(name string) (windows.Handle, error) {
			return windows.CreateMutex(nil, false, windows.StringToUTF16Ptr(name))
		},
		windows.CloseHandle, func(string) error { return errors.New("unexpected second fixture owner") })
	if err != nil || instance.forwarded {
		t.Fatal("native helper could not acquire ownership", err)
	}
	defer instance.release()
	root := os.Getenv("CONVENE_WIRE_ACTIVATION_HELPER_ROOT")
	service, err := activationTestConsole(root)
	if err != nil {
		t.Fatal("isolated helper Console failed", err)
	}
	defer service.Close() // Must happen before releasing the native mutex.
	defer activation.close()
	fmt.Println("owner ready")
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil || line != "create window\n" {
		t.Fatal("missing fixture startup gate")
	}
	legacy := os.Getenv("CONVENE_WIRE_ACTIVATION_HELPER_LEGACY") == "true"
	className, parent := name, w32.HWND(0)
	if legacy {
		className, parent = name+"-legacy", w32.HWND_MESSAGE
	}
	callback := syscall.NewCallback(func(hwnd w32.HWND, message uint32, wParam, lParam uintptr) uintptr {
		if message == 0x8001 {
			activation.close()
			w32.PostQuitMessage(0)
			return 0
		}
		// Fixture control is not WM_COPYDATA and must not depend on the
		// production activation decoder accepting it.
		if message == 0x8002 {
			fmt.Println("blocked")
			line, err := bufio.NewReader(os.Stdin).ReadString('\n')
			if err != nil || line != "unblock\n" {
				t.Error("missing fixture UI release")
			}
			return 0
		}
		if ack, handled := receiveWindowsActivation(message, lParam, &activation); handled {
			if legacy {
				return 0
			}
			return ack
		}
		return w32.DefWindowProc(hwnd, message, wParam, lParam)
	})
	class := w32.WNDCLASSEX{WndProc: callback, Instance: w32.GetModuleHandle(""), ClassName: windows.StringToUTF16Ptr(className)}
	class.Size = uint32(unsafe.Sizeof(class))
	if w32.RegisterClassEx(&class) == 0 {
		t.Fatal("register native fixture window")
	}
	hwnd := w32.CreateWindowEx(0, class.ClassName, windows.StringToUTF16Ptr(name+"-name"), 0, 0, 0, 0, 0, parent, 0, class.Instance, nil)
	if hwnd == 0 {
		t.Fatal("create native fixture window")
	}
	defer w32.DestroyWindow(hwnd)
	activation.ready(func(fn func()) { fn() }, func(link string) {
		if link == "" {
			fmt.Println("wake")
		} else if link == testActivationLink() {
			fmt.Println("paired")
		} else {
			fmt.Println("invalid pairing")
		}
	})
	fmt.Println("window ready")
	var message w32.MSG
	for {
		result := w32.GetMessage(&message, 0, 0, 0)
		if result == 0 {
			return
		}
		if result < 0 {
			t.Fatal("native message loop failed")
		}
		w32.TranslateMessage(&message)
		w32.DispatchMessage(&message)
	}
}

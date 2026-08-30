//go:build desktop && darwin

package main

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// Cocoa must be entered on the original OS main thread, not a testing.T
// goroutine pinned to an arbitrary background thread. Wails' package init
// already pins the goroutine that invokes TestMain to the OS main thread.
func TestMain(tests *testing.M) {
	if mode := os.Getenv("CONVENE_WIRE_NATIVE_CAPTURE_HELPER"); mode != "" {
		os.Exit(runDarwinCaptureHelper(mode))
	}
	os.Exit(tests.Run())
}

func runDarwinCaptureHelper(mode string) int {
	if mode == "tempdir" {
		root, err := darwinNativeTempDirectory()
		if err != nil || strings.HasPrefix(root, os.Getenv("TMPDIR")) || validateDarwinDirectory(strings.TrimRight(root, "/"), uint32(os.Geteuid())) != nil {
			fmt.Println("system temporary directory rejected")
			return 3
		}
		fmt.Println("system temporary directory verified")
		return 0
	}
	options := darwinInstanceOptions{
		TempDir: os.Getenv("CONVENE_WIRE_NATIVE_CAPTURE_ROOT"), InstanceID: "cw-native-url-fixture",
		ExpectedUID: uint32(os.Geteuid()), StartupTimeout: 2 * time.Second, IOTimeout: time.Second,
		MaxConnections: 2, CaptureTimeout: 500 * time.Millisecond,
		CaptureURL: func(timeout time.Duration) (string, error) {
			if mode != "wake" {
				link := testActivationLink()
				if mode == "invalid" {
					link = "convenewire://unexpected#claimSecret=must-not-be-logged"
				}
				if mode == "oversized" {
					link = strings.Repeat("s", maxPairingLinkBytes+1)
				}
				if err := queueDarwinSelfURL(link, 25*time.Millisecond); err != nil {
					return "", err
				}
			}
			return captureDarwinLaunchURL(timeout)
		},
	}
	err := runWithDesktopInstance(func() (*desktopInstance, error) {
		return acquireDarwinInstance("", &desktopActivation{}, options)
	}, func(*desktopInstance) error {
		return fmt.Errorf("native secondary fixture must not become primary")
	})
	if err != nil {
		fmt.Println("capture rejected")
		return 3
	}
	fmt.Println("activation acknowledged")
	return 0
}

func TestDarwinNativeAppleEventCaptureForwardsOnlyValidatedIntent(t *testing.T) {
	for _, mode := range []string{"pairing", "wake", "invalid", "oversized"} {
		t.Run(mode, func(t *testing.T) {
			// Darwin sockaddr_un allows only 103 pathname bytes. The normal Go
			// test temp root may be longer; this private fixture has an exact owner.
			root, err := os.MkdirTemp("/private/tmp", "cwurl-")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := os.RemoveAll(root); err != nil {
					t.Error(err)
				}
			})
			activation := &desktopActivation{}
			options := darwinInstanceOptions{TempDir: root, InstanceID: "cw-native-url-fixture", ExpectedUID: uint32(os.Geteuid()),
				StartupTimeout: time.Second, IOTimeout: time.Second, MaxConnections: 2}
			primary, err := acquireDarwinInstance("", activation, options)
			if err != nil {
				t.Fatal(err)
			}
			defer primary.release()
			deliveries := make(chan string, 2)
			activation.ready(func(deliver func()) { deliver() }, func(link string) { deliveries <- link })
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, os.Args[0])
			command.Env = append(os.Environ(), "CONVENE_WIRE_NATIVE_CAPTURE_HELPER="+mode, "CONVENE_WIRE_NATIVE_CAPTURE_ROOT="+root)
			var output bytes.Buffer
			command.Stdout, command.Stderr = &output, &output
			err = command.Run()
			if ctx.Err() != nil {
				t.Fatal("native AppleEvent fixture exceeded its deadline")
			}
			if mode == "invalid" || mode == "oversized" {
				if err == nil || !strings.Contains(output.String(), "capture rejected") {
					t.Fatalf("malformed AppleEvent accepted: %s", output.String())
				}
				select {
				case <-deliveries:
					t.Fatal("malformed AppleEvent reached the primary")
				default:
				}
			} else {
				if err != nil {
					t.Fatalf("native capture failed: %v; %s", err, output.String())
				}
				select {
				case link := <-deliveries:
					want := ""
					if mode == "pairing" {
						want = testActivationLink()
					}
					if link != want {
						t.Fatal("native AppleEvent was lost or changed into a wake")
					}
				default:
					t.Fatal("secondary exited without acknowledged delivery")
				}
			}
			if strings.Contains(output.String(), "claimSecret") || strings.Contains(output.String(), "must-not-be-logged") || strings.Contains(output.String(), root) {
				t.Fatal("native capture output exposed proof or local paths")
			}
		})
	}
}

func TestDarwinNativeCaptureRejectsBackgroundThreadAndInvalidTimeout(t *testing.T) {
	// A normal testing.T goroutine is not the Cocoa main thread. This must fail
	// promptly rather than silently running AppKit on the wrong native thread.
	if _, err := captureDarwinLaunchURL(25 * time.Millisecond); err == nil {
		t.Fatal("Cocoa capture unexpectedly accepted a background OS thread")
	}
	if _, err := captureDarwinLaunchURL(0); err == nil {
		t.Fatal("unbounded capture timeout accepted")
	}
}

func TestDarwinNativeTemporaryDirectoryDoesNotUseEnvironmentOverride(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, os.Args[0])
	command.Env = append(os.Environ(), "CONVENE_WIRE_NATIVE_CAPTURE_HELPER=tempdir", "TMPDIR="+t.TempDir())
	output, err := command.CombinedOutput()
	if err != nil || !strings.Contains(string(output), "system temporary directory verified") {
		t.Fatalf("OS temporary-directory fixture failed: %v; %s", err, string(output))
	}
}

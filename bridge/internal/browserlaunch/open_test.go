package browserlaunch

import (
	"errors"
	"reflect"
	"testing"
)

func TestOpenLoopbackUsesPlatformBrowserCommands(t *testing.T) {
	tests := []struct {
		goos     string
		wantName string
		wantArgs []string
	}{
		{goos: "darwin", wantName: "open", wantArgs: []string{"http://127.0.0.1:3210/?token=test"}},
		{goos: "windows", wantName: "rundll32", wantArgs: []string{"url.dll,FileProtocolHandler", "http://127.0.0.1:3210/?token=test"}},
		{goos: "linux", wantName: "xdg-open", wantArgs: []string{"http://127.0.0.1:3210/?token=test"}},
	}
	for _, test := range tests {
		t.Run(test.goos, func(t *testing.T) {
			var gotName string
			var gotArguments []string
			err := openLoopback(test.goos, "http://127.0.0.1:3210/?token=test", func(name string, arguments ...string) error {
				gotName = name
				gotArguments = arguments
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			if gotName != test.wantName || !reflect.DeepEqual(gotArguments, test.wantArgs) {
				t.Fatalf("unexpected browser command: %s %#v", gotName, gotArguments)
			}
		})
	}
}

func TestOpenLoopbackRejectsExternalAndUnsupportedTargets(t *testing.T) {
	starter := func(string, ...string) error {
		return errors.New("must not be called")
	}
	for _, rawURL := range []string{
		"https://127.0.0.1:3210/",
		"http://example.com/",
		"http://user@127.0.0.1:3210/",
		"not-a-url",
	} {
		if err := openLoopback("darwin", rawURL, starter); err == nil {
			t.Fatalf("expected %q to be rejected", rawURL)
		}
	}
	if err := openLoopback("plan9", "http://[::1]:3210/", starter); err == nil {
		t.Fatal("expected unsupported platform to be rejected")
	}
}

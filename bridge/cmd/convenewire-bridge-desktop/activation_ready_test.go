//go:build desktop

package main

import (
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

func TestDesktopActivationWaitsForActualPageNavigation(t *testing.T) {
	for platform, loaded := range map[string]events.WindowEventType{
		"windows": events.Windows.WebViewNavigationCompleted,
		"darwin":  events.Mac.WebViewDidFinishNavigation,
		"linux":   events.Linux.WindowLoadFinished,
	} {
		t.Run(platform, func(t *testing.T) {
			activation, err := newDesktopActivation(testActivationLink())
			if err != nil {
				t.Fatal(err)
			}
			defer activation.close()
			listeners := map[events.WindowEventType]func(*application.WindowEvent){}
			var scheduled []func()
			var delivered []string
			bindActivationToLoadedPage(func(event events.WindowEventType, callback func(*application.WindowEvent)) func() {
				listeners[event] = callback
				return func() { delete(listeners, event) }
			}, platform, activation, func(fn func()) { scheduled = append(scheduled, fn) }, func(link string) {
				delivered = append(delivered, link)
			})
			if len(listeners) != 1 || listeners[loaded] == nil {
				t.Fatal("wrong native readiness boundary")
			}
			// Early messages may be dispatched while WebView2 Embed pumps Windows
			// messages, but must not navigate or even schedule delivery yet.
			if !activation.accept("") || !activation.accept(testActivationLink()) || len(scheduled) != 0 {
				t.Fatal("early activation bypassed page readiness")
			}
			listeners[loaded](nil)
			if len(scheduled) != 1 || len(delivered) != 0 {
				t.Fatal("page readiness did not use the UI dispatcher")
			}
			scheduled[0]()
			listeners[loaded](nil)
			if len(scheduled) != 1 || len(delivered) != 1 || delivered[0] != testActivationLink() {
				t.Fatal("reload duplicated or lost initial intent")
			}
			activation.close()
			listeners[loaded](nil)
			if activation.accept("") {
				t.Fatal("closed activation accepted a wake")
			}
		})
	}
}

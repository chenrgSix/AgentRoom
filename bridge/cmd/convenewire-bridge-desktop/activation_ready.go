//go:build desktop

package main

import (
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// ApplicationStarted precedes asynchronous WebView2 controller creation. Its
// nested message pump can already accept WM_COPYDATA, so it is not a safe
// navigation barrier. Each platform's finished-navigation event comes from the
// actual WebView, after the initial Console page has loaded.
func bindActivationToLoadedPage(
	on func(events.WindowEventType, func(*application.WindowEvent)) func(),
	platform string, activation *desktopActivation,
	dispatch func(func()), deliver func(string),
) {
	var loaded events.WindowEventType
	switch platform {
	case "windows":
		loaded = events.Windows.WebViewNavigationCompleted
	case "darwin":
		loaded = events.Mac.WebViewDidFinishNavigation
	case "linux":
		loaded = events.Linux.WindowLoadFinished
	default:
		return // No known safe navigation boundary; retain rather than lose intent.
	}
	on(loaded, func(*application.WindowEvent) {
		// ready is idempotent: later navigations cannot repeat initial delivery.
		activation.ready(dispatch, deliver)
	})
}

package browserlaunch

import (
	"fmt"
	"net"
	"net/url"
	"regexp"
	"runtime"
	"strings"
)

// OpenClientEntry accepts an exact Central origin and one short-lived proof,
// never an arbitrary redirect supplied by an HTTP response.
func OpenClientEntry(origin, ticket string) error {
	return openClientEntry(runtime.GOOS, origin, origin, ticket, startCommand)
}

// OpenClientEntryForBridge accepts a browser origin only when it is the exact
// authenticated Bridge origin or the same host's explicit LAN HTTP surface.
func OpenClientEntryForBridge(bridgeOrigin, browserOrigin, ticket string) error {
	return openClientEntry(runtime.GOOS, bridgeOrigin, browserOrigin, ticket, startCommand)
}

func exactOrigin(origin string) (*url.URL, error) {
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" || parsed.User != nil ||
		(parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, fmt.Errorf("client entry target is invalid")
	}
	return parsed, nil
}

func clientEntryBrowserOrigin(bridgeOrigin, browserOrigin string) (*url.URL, error) {
	bridge, err := exactOrigin(bridgeOrigin)
	if err != nil {
		return nil, err
	}
	browser, err := exactOrigin(browserOrigin)
	if err != nil {
		return nil, err
	}
	bridgeIP := net.ParseIP(bridge.Hostname())
	bridgeLoopback := strings.EqualFold(bridge.Hostname(), "localhost") ||
		(bridgeIP != nil && bridgeIP.IsLoopback())
	bridgeAllowed := bridge.Scheme == "https" || (bridge.Scheme == "http" && bridgeLoopback)
	if !bridgeAllowed {
		return nil, fmt.Errorf("client entry Bridge origin is invalid")
	}
	if browser.Scheme == bridge.Scheme && browser.Host == bridge.Host {
		return browser, nil
	}
	if bridge.Scheme == "https" && browser.Scheme == "http" &&
		strings.EqualFold(browser.Hostname(), bridge.Hostname()) {
		return browser, nil
	}
	return nil, fmt.Errorf("client entry browser origin is not bound to the Bridge origin")
}

func openClientEntry(goos, bridgeOrigin, browserOrigin, ticket string, start commandStarter) error {
	parsed, err := clientEntryBrowserOrigin(bridgeOrigin, browserOrigin)
	if err != nil || !regexp.MustCompile(`^[A-Za-z0-9_-]{43,128}$`).MatchString(ticket) {
		return fmt.Errorf("client entry target is invalid")
	}
	parsed.Path = "/"
	parsed.Fragment = "clientEntry=" + ticket
	name, args, err := browserCommand(goos, parsed.String())
	if err != nil {
		return err
	}
	if err := start(name, args...); err != nil {
		return fmt.Errorf("could not open the client entry browser")
	}
	return nil
}

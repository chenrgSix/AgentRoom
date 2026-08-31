package browserlaunch

import (
	"fmt"
	"net"
	"net/url"
	"regexp"
	"runtime"
)

// OpenClientEntry accepts an exact Central origin and one short-lived proof,
// never an arbitrary redirect supplied by an HTTP response.
func OpenClientEntry(origin, ticket string) error {
	return openClientEntry(runtime.GOOS, origin, ticket, startCommand)
}

func openClientEntry(goos, origin, ticket string, start commandStarter) error {
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" || parsed.User != nil ||
		(parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" ||
		!regexp.MustCompile(`^[A-Za-z0-9_-]{43,128}$`).MatchString(ticket) {
		return fmt.Errorf("client entry target is invalid")
	}
	ip := net.ParseIP(parsed.Hostname())
	loopback := parsed.Hostname() == "localhost" || (ip != nil && ip.IsLoopback())
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && loopback) {
		return fmt.Errorf("client entry requires HTTPS except on loopback")
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

package browserlaunch

import (
	"fmt"
	"net"
	"net/url"
	"os/exec"
	"runtime"
	"strings"
)

type commandStarter func(string, ...string) error

// OpenLoopback opens the local Bridge Console in the platform browser.
func OpenLoopback(rawURL string) error {
	return openLoopback(runtime.GOOS, rawURL, startCommand)
}

func openLoopback(goos, rawURL string, start commandStarter) error {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme != "http" || parsed.Host == "" || parsed.User != nil {
		return fmt.Errorf("Console URL must be an absolute HTTP URL")
	}
	host := parsed.Hostname()
	ip := net.ParseIP(host)
	if !strings.EqualFold(host, "localhost") && (ip == nil || !ip.IsLoopback()) {
		return fmt.Errorf("Console browser opener accepts only loopback URLs")
	}

	name, arguments, err := browserCommand(goos, rawURL)
	if err != nil {
		return err
	}
	if err := start(name, arguments...); err != nil {
		return fmt.Errorf("open Console browser: %w", err)
	}
	return nil
}

func browserCommand(goos, rawURL string) (string, []string, error) {
	switch goos {
	case "darwin":
		return "open", []string{rawURL}, nil
	case "windows":
		return "rundll32", []string{"url.dll,FileProtocolHandler", rawURL}, nil
	case "linux":
		return "xdg-open", []string{rawURL}, nil
	default:
		return "", nil, fmt.Errorf("automatic browser opening is unsupported on %s", goos)
	}
}

func startCommand(name string, arguments ...string) error {
	command := exec.Command(name, arguments...)
	if err := command.Start(); err != nil {
		return err
	}
	go func() { _ = command.Wait() }()
	return nil
}

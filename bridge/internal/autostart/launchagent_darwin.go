//go:build darwin

package autostart

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// Keep the released label so enabling startup repairs the existing job instead
// of creating a second Bridge process under the new display name.
const launchAgentLabel = "dev.agentroom.bridge.desktop"

type commandRunner func(context.Context, string, ...string) ([]byte, error)

type launchAgentController struct {
	executable string
	arguments  []string
	plistPath  string
	domain     string
	run        commandRunner
}

func newPlatformController(executable string, arguments []string) Controller {
	home, err := os.UserHomeDir()
	if err != nil {
		return unsupportedController{reason: err.Error()}
	}
	return newLaunchAgentController(
		executable,
		arguments,
		filepath.Join(home, "Library", "LaunchAgents", launchAgentLabel+".plist"),
		"gui/"+strconv.Itoa(os.Getuid()),
		func(ctx context.Context, name string, args ...string) ([]byte, error) {
			return exec.CommandContext(ctx, name, args...).CombinedOutput()
		},
	)
}

func newLaunchAgentController(
	executable string,
	arguments []string,
	plistPath string,
	domain string,
	runner commandRunner,
) *launchAgentController {
	return &launchAgentController{
		executable: executable,
		arguments:  append([]string{}, arguments...),
		plistPath:  plistPath,
		domain:     domain,
		run:        runner,
	}
}

func (c *launchAgentController) State() (State, error) {
	expected, err := buildLaunchAgentPlist(c.executable, c.arguments)
	if err != nil {
		return State{Supported: true, PlistPath: c.plistPath}, err
	}
	actual, err := os.ReadFile(c.plistPath)
	if errors.Is(err, os.ErrNotExist) {
		return State{Supported: true, PlistPath: c.plistPath}, nil
	}
	if err != nil {
		return State{Supported: true, PlistPath: c.plistPath}, err
	}
	return State{
		Supported: true, Enabled: true, PlistPath: c.plistPath,
		PathMismatch: !bytes.Equal(actual, expected),
	}, nil
}

func (c *launchAgentController) SetEnabled(ctx context.Context, enabled bool) (State, error) {
	if !enabled {
		if err := os.Remove(c.plistPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return State{Supported: true, PlistPath: c.plistPath}, fmt.Errorf("remove login startup: %w", err)
		}
		return c.State()
	}
	current, stateErr := c.State()
	if stateErr == nil && current.Enabled && !current.PathMismatch {
		return current, nil
	}
	source, err := buildLaunchAgentPlist(c.executable, c.arguments)
	if err != nil {
		return State{Supported: true, PlistPath: c.plistPath}, err
	}
	if err := writeAtomic(c.plistPath, source); err != nil {
		return State{Supported: true, PlistPath: c.plistPath}, err
	}
	// Replacing an existing plist repairs a moved application for the next
	// login. Do not bootout/bootstrap the loaded job: bootout could terminate
	// the GUI currently serving this request.
	if current.Enabled {
		return c.State()
	}
	output, err := c.run(ctx, "launchctl", "bootstrap", c.domain, c.plistPath)
	if err != nil && !strings.Contains(strings.ToLower(string(output)), "already loaded") {
		_ = os.Remove(c.plistPath)
		return State{Supported: true, PlistPath: c.plistPath}, fmt.Errorf("register login startup: %s", strings.TrimSpace(string(output)))
	}
	return c.State()
}

func buildLaunchAgentPlist(executable string, arguments []string) ([]byte, error) {
	if !filepath.IsAbs(executable) {
		return nil, fmt.Errorf("desktop executable path must be absolute")
	}
	values := append([]string{executable}, arguments...)
	var document bytes.Buffer
	document.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n")
	document.WriteString("<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"https://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n")
	document.WriteString("<plist version=\"1.0\"><dict>\n")
	document.WriteString("<key>Label</key><string>" + launchAgentLabel + "</string>\n")
	document.WriteString("<key>ProgramArguments</key><array>\n")
	for _, value := range values {
		document.WriteString("<string>")
		if err := xml.EscapeText(&document, []byte(value)); err != nil {
			return nil, err
		}
		document.WriteString("</string>\n")
	}
	document.WriteString("</array>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><false/>\n")
	document.WriteString("<key>LimitLoadToSessionType</key><string>Aqua</string>\n")
	document.WriteString("</dict></plist>\n")
	return document.Bytes(), nil
}

func writeAtomic(path string, source []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create LaunchAgents directory: %w", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".convenewire-launchagent-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(source); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("install login startup: %w", err)
	}
	return nil
}

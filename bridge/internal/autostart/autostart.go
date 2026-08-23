package autostart

import (
	"context"
	"fmt"
)

type State struct {
	Supported    bool   `json:"supported"`
	Enabled      bool   `json:"enabled"`
	PathMismatch bool   `json:"pathMismatch,omitempty"`
	PlistPath    string `json:"plistPath,omitempty"`
}

type Controller interface {
	State() (State, error)
	SetEnabled(context.Context, bool) (State, error)
}

func New(executable string, arguments []string) Controller {
	return newPlatformController(executable, arguments)
}

type unsupportedController struct {
	reason string
}

func (c unsupportedController) State() (State, error) {
	return State{Supported: false}, nil
}

func (c unsupportedController) SetEnabled(context.Context, bool) (State, error) {
	return State{Supported: false}, fmt.Errorf("%s", c.reason)
}

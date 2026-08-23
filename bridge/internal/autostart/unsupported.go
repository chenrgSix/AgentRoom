//go:build !darwin

package autostart

func newPlatformController(string, []string) Controller {
	return unsupportedController{reason: "login startup is currently supported only on macOS"}
}

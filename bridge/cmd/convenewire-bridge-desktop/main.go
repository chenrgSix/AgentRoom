//go:build desktop

package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"convenewire.dev/bridge/internal/autostart"
	"convenewire.dev/bridge/internal/bridgecore"
	"convenewire.dev/bridge/internal/buildidentity"
	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/connection"
	"convenewire.dev/bridge/internal/console"
	"convenewire.dev/bridge/internal/enrollment"
	"convenewire.dev/bridge/internal/operations"
	"convenewire.dev/bridge/internal/pairing"
	"convenewire.dev/bridge/internal/updatecheck"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"github.com/wailsapp/wails/v3/pkg/icons"
)

var (
	version      = "dev"
	sourceCommit = ""
)

func main() {
	if err := buildidentity.Initialize(sourceCommit); err != nil {
		log.Fatal(err)
	}
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	configPath := flag.String("config", "", "path to Bridge JSON configuration")
	dataDir := flag.String("data-dir", "", "directory for Bridge state and credential")
	workspace := flag.String("workspace", "", "default local Runtime workspace")
	pairingLink := flag.String("pairing-link", "", "Device pairing link from the Owner Web client")
	showVersion := flag.Bool("version", false, "print the Bridge version and exit")
	background := flag.Bool("background", false, "start with only the system tray visible")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return nil
	}
	initialPairingLink, err := pairingLinkFromLaunch(*pairingLink, flag.Args())
	if err != nil {
		return err
	}
	if *configPath == "" {
		*configPath = config.DefaultPath()
	}
	resolvedConfigPath, err := filepath.Abs(*configPath)
	if err != nil {
		return fmt.Errorf("resolve Bridge config path: %w", err)
	}
	*configPath = resolvedConfigPath
	if *dataDir != "" {
		*dataDir, err = filepath.Abs(*dataDir)
		if err != nil {
			return fmt.Errorf("resolve Bridge data directory: %w", err)
		}
	}
	if *workspace != "" {
		*workspace, err = filepath.Abs(*workspace)
		if err != nil {
			return fmt.Errorf("resolve Bridge workspace: %w", err)
		}
	}
	activation, err := newDesktopActivation(initialPairingLink)
	if err != nil {
		return err
	}
	defer activation.close()
	return runWithDesktopInstance(func() (*desktopInstance, error) {
		return acquireDesktopInstance(initialPairingLink, activation)
	}, func(instance *desktopInstance) error {
		return runPrimaryDesktop(*configPath, *dataDir, *workspace, initialPairingLink, *background, activation, instance)
	})
}

func runPrimaryDesktop(configPath, dataDir, workspace, initialPairingLink string, background bool,
	activation *desktopActivation, instance *desktopInstance,
) error {
	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve desktop executable: %w", err)
	}
	loginStartup := autostart.New(executable, loginArguments(configPath, dataDir, workspace))
	var service *console.Service
	var window *application.WebviewWindow
	stopStatus := make(chan struct{})
	var shutdownOnce sync.Once
	shutdown := func() {
		shutdownOnce.Do(func() {
			activation.close()
			close(stopStatus)
			if service != nil {
				service.Close()
			}
		})
	}
	defer shutdown()
	assetRouter := http.NewServeMux()
	windowsOptions := instance.windows
	windowsOptions.DisableQuitOnLastWindowClosed = true
	// Darwin and Windows already hold their native instance lease and transport.
	// The remaining platforms arbitrate in New, before mutable Console state.
	app := application.New(application.Options{
		Name:        "ConveneWire Bridge",
		Description: "Connect local Codex and Pi runtimes to an ConveneWire Team",
		Icon:        desktopApplicationIcon(runtime.GOOS),
		Assets: application.AssetOptions{
			Handler: assetRouter, DisableLogging: true,
		},
		SingleInstance: instance.singleInstance,
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: false,
		},
		Windows: windowsOptions, OnShutdown: shutdown,
	})

	service, err = console.New(console.Options{
		ConfigPath: configPath,
		DataDir:    dataDir,
		Workspace:  workspace,
		Version:    version,
	}, console.Dependencies{
		Enroll: enrollment.Join,
		PairDevice: func(ctx context.Context, loaded config.Config, input pairing.SessionInput, show func(pairing.SessionStatus)) (pairing.Credential, error) {
			return (pairing.SessionClient{BridgeVersion: version}).Pair(ctx, loaded, input, show)
		},
		SaveConfig:     config.Save,
		ReplaceConfig:  config.Replace,
		SaveCredential: pairing.Save,
		LoginStartup:   loginStartup,
		UpdateChecker:  updatecheck.New(),
		ProbeRuntime:   console.ProbeRuntime,
		RunBridge: func(ctx context.Context, loaded config.Config, credential pairing.Credential, observer operations.Observer) error {
			return bridgecore.RunObserved(ctx, loaded, credential, version, observer)
		},
		RunBridgeWithProvisioning: func(ctx context.Context, loaded config.Config, credential pairing.Credential, observer operations.Observer, handler connection.ProvisionHandler) error {
			return bridgecore.RunObservedWithProvisioning(ctx, loaded, credential, version, observer, handler)
		},
	})
	if err != nil {
		return err
	}
	assetRouter.Handle("/", service.Handler())
	if err := service.StartConfiguredBridge(); err != nil {
		return err
	}

	window = app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:  "ConveneWire Bridge",
		Title: "ConveneWire Bridge",
		// Initial and forwarded pairing both arrive through the activation queue.
		URL:              consoleWindowURL(service.Token(), ""),
		Width:            980,
		Height:           780,
		MinWidth:         760,
		MinHeight:        620,
		BackgroundColour: application.NewRGB(12, 17, 13),
		DevToolsEnabled:  false,
	})
	if background && service.State().Configured && initialPairingLink == "" {
		window.Hide()
	}
	bindActivationToLoadedPage(window.OnWindowEvent, runtime.GOOS, activation, application.InvokeAsync, func(link string) {
		if link != "" {
			window.SetURL(consoleWindowURL(service.Token(), link))
		}
		window.Show()
		window.Restore()
		window.Focus()
	})
	window.RegisterHook(events.Common.WindowClosing, func(event *application.WindowEvent) {
		window.Hide()
		event.Cancel()
	})
	app.Event.OnApplicationEvent(events.Common.ApplicationLaunchedWithUrl, func(event *application.ApplicationEvent) {
		link, linkErr := pairingLinkFromLaunch(event.Context().URL(), nil)
		if linkErr != nil || link == "" {
			return
		}
		activation.accept(link)
	})
	if runtime.GOOS == "darwin" {
		app.Event.OnApplicationEvent(events.Mac.ApplicationShouldHandleReopen, func(*application.ApplicationEvent) {
			activation.accept("")
		})
	}

	tray := app.SystemTray.New()
	if runtime.GOOS == "darwin" {
		tray.SetTemplateIcon(icons.SystrayMacTemplate)
	} else {
		tray.SetIcon(desktopTrayIcon(runtime.GOOS))
	}
	tray.SetTooltip("ConveneWire Bridge")
	menu := app.NewMenu()
	statusItem := menu.Add("状态：正在读取").SetEnabled(false)
	menu.Add("打开 ConveneWire Bridge").OnClick(func(*application.Context) {
		window.Show()
		window.Restore()
		window.Focus()
	})
	menu.AddSeparator()
	startItem := menu.Add("启动 Bridge").OnClick(func(*application.Context) {
		if _, startErr := service.StartBridge(); startErr != nil {
			app.Dialog.Error().SetTitle("无法启动 Bridge").SetMessage(startErr.Error()).Show()
		}
	})
	stopItem := menu.Add("停止 Bridge").OnClick(func(*application.Context) {
		service.StopBridge()
	})
	menu.AddSeparator()
	menu.Add("退出").OnClick(func(*application.Context) {
		app.Quit()
	})
	tray.SetMenu(menu)
	tray.OnClick(func() {
		window.Show()
		window.Restore()
		window.Focus()
	})

	setTrayState(service.State(), statusItem, startItem, stopItem)
	go refreshTray(stopStatus, service, statusItem, startItem, stopItem)
	if err := app.Run(); err != nil {
		return fmt.Errorf("run desktop application: %w", err)
	}
	return nil
}

func pairingLinkFromLaunch(explicit string, arguments []string) (string, error) {
	if len(explicit) > maxPairingLinkBytes || len(arguments) > 32 {
		return "", fmt.Errorf("desktop activation exceeds its input limit")
	}
	candidates := make([]string, 0, len(arguments)+1)
	if strings.TrimSpace(explicit) != "" {
		candidates = append(candidates, strings.TrimSpace(explicit))
	}
	for _, argument := range arguments {
		if len(argument) > maxPairingLinkBytes {
			return "", fmt.Errorf("desktop activation exceeds its input limit")
		}
		trimmed := strings.TrimSpace(argument)
		lower := strings.ToLower(trimmed)
		if strings.HasPrefix(lower, "convenewire://") || strings.HasPrefix(lower, "agentroom://") {
			candidates = append(candidates, trimmed)
		}
	}
	if len(candidates) == 0 {
		return "", nil
	}
	if len(candidates) != 1 {
		return "", fmt.Errorf("desktop launch contains multiple Device pairing links")
	}
	if _, err := pairing.ParseSessionLink(candidates[0]); err != nil {
		return "", fmt.Errorf("desktop launch contains an invalid Device pairing link")
	}
	return candidates[0], nil
}

func consoleWindowURL(token, pairingLink string) string {
	result := "/?token=" + url.QueryEscape(token)
	if pairingLink != "" {
		result += "#pairingLink=" + url.QueryEscape(pairingLink)
	}
	return result
}

func loginArguments(configPath, dataDir, workspace string) []string {
	arguments := []string{"--background", "--config", configPath}
	if dataDir != "" {
		arguments = append(arguments, "--data-dir", dataDir)
	}
	if workspace != "" {
		arguments = append(arguments, "--workspace", workspace)
	}
	return arguments
}

func refreshTray(
	stop <-chan struct{},
	service *console.Service,
	statusItem *application.MenuItem,
	startItem *application.MenuItem,
	stopItem *application.MenuItem,
) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			state := service.State()
			application.InvokeAsync(func() {
				setTrayState(state, statusItem, startItem, stopItem)
			})
		}
	}
}

func setTrayState(
	state console.State,
	statusItem *application.MenuItem,
	startItem *application.MenuItem,
	stopItem *application.MenuItem,
) {
	statusItem.SetLabel("状态：" + phaseLabel(state))
	startItem.SetEnabled(state.Paired && !state.BridgeRunning)
	stopItem.SetEnabled(state.BridgeRunning)
}

func phaseLabel(state console.State) string {
	if state.BridgeRunning {
		switch state.Connection.State {
		case operations.ConnectionOnline:
			return "在线"
		case operations.ConnectionRetrying:
			return "重连中"
		case operations.ConnectionConnecting:
			return "连接中"
		}
	}
	switch state.Phase {
	case console.PhaseUnconfigured:
		return "等待配置"
	case console.PhaseReady:
		return "已停止"
	case console.PhaseJoining:
		return "正在加入"
	case console.PhaseApproval:
		return "等待审批"
	case console.PhaseRunning:
		return "连接中"
	case console.PhaseError:
		return "需要处理"
	default:
		return string(state.Phase)
	}
}

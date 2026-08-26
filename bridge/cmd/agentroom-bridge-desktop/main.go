//go:build desktop

package main

import (
	"context"
	"crypto/sha256"
	"flag"
	"fmt"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"agentroom.dev/bridge/internal/autostart"
	"agentroom.dev/bridge/internal/bridgecore"
	"agentroom.dev/bridge/internal/config"
	"agentroom.dev/bridge/internal/console"
	"agentroom.dev/bridge/internal/enrollment"
	"agentroom.dev/bridge/internal/operations"
	"agentroom.dev/bridge/internal/pairing"
	"agentroom.dev/bridge/internal/updatecheck"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"github.com/wailsapp/wails/v3/pkg/icons"
)

var version = "dev"

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	configPath := flag.String("config", "", "path to Bridge JSON configuration")
	dataDir := flag.String("data-dir", "", "directory for Bridge state and credential")
	workspace := flag.String("workspace", "", "default local Runtime workspace")
	showVersion := flag.Bool("version", false, "print the Bridge version and exit")
	background := flag.Bool("background", false, "start with only the system tray visible")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return nil
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
	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve desktop executable: %w", err)
	}
	loginStartup := autostart.New(executable, loginArguments(*configPath, *dataDir, *workspace))

	service, err := console.New(console.Options{
		ConfigPath: *configPath,
		DataDir:    *dataDir,
		Workspace:  *workspace,
		Version:    version,
	}, console.Dependencies{
		Enroll:         enrollment.Join,
		SaveConfig:     config.Save,
		ReplaceConfig:  config.Replace,
		SaveCredential: pairing.Save,
		LoginStartup:   loginStartup,
		UpdateChecker:  updatecheck.New(),
		ProbeRuntime:   console.ProbeRuntime,
		RunBridge: func(ctx context.Context, loaded config.Config, credential pairing.Credential, observer operations.Observer) error {
			return bridgecore.RunObserved(ctx, loaded, credential, version, observer)
		},
	})
	if err != nil {
		return err
	}
	if err := service.StartConfiguredBridge(); err != nil {
		service.Close()
		return err
	}

	var window *application.WebviewWindow
	stopStatus := make(chan struct{})
	instanceKey := sha256.Sum256([]byte("agentroom.dev.bridge.desktop.instance.v1"))
	app := application.New(application.Options{
		Name:        "AgentRoom Bridge",
		Description: "Connect local Codex and Pi runtimes to an AgentRoom Team",
		Icon:        icons.ApplicationLightMode256,
		Assets: application.AssetOptions{
			Handler:        service.Handler(),
			DisableLogging: true,
		},
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID:      "dev.agentroom.bridge.desktop",
			EncryptionKey: instanceKey,
			OnSecondInstanceLaunch: func(application.SecondInstanceData) {
				if window != nil {
					window.Show()
					window.Restore()
					window.Focus()
				}
			},
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: false,
		},
		Windows: application.WindowsOptions{
			DisableQuitOnLastWindowClosed: true,
		},
		OnShutdown: func() {
			close(stopStatus)
			service.Close()
		},
	})

	window = app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:             "AgentRoom Bridge",
		Title:            "AgentRoom Bridge",
		URL:              "/?token=" + url.QueryEscape(service.Token()),
		Width:            980,
		Height:           780,
		MinWidth:         760,
		MinHeight:        620,
		BackgroundColour: application.NewRGB(12, 17, 13),
		DevToolsEnabled:  false,
	})
	if *background && service.State().Configured {
		window.Hide()
	}
	window.RegisterHook(events.Common.WindowClosing, func(event *application.WindowEvent) {
		window.Hide()
		event.Cancel()
	})
	if runtime.GOOS == "darwin" {
		app.Event.OnApplicationEvent(events.Mac.ApplicationShouldHandleReopen, func(*application.ApplicationEvent) {
			window.Show()
			window.Restore()
			window.Focus()
		})
	}

	tray := app.SystemTray.New()
	if runtime.GOOS == "darwin" {
		tray.SetTemplateIcon(icons.SystrayMacTemplate)
	} else {
		tray.SetIcon(icons.SystrayLight)
	}
	tray.SetTooltip("AgentRoom Bridge")
	menu := app.NewMenu()
	statusItem := menu.Add("状态：正在读取").SetEnabled(false)
	menu.Add("打开 AgentRoom Bridge").OnClick(func(*application.Context) {
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
		service.Close()
		return fmt.Errorf("run desktop application: %w", err)
	}
	return nil
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

module convenewire.dev/bridge

go 1.26.7

require convenewire.dev/contracts v0.0.0

require github.com/coder/websocket v1.8.15

require golang.org/x/sys v0.46.0

require (
	github.com/santhosh-tekuri/jsonschema/v6 v6.0.3 // indirect
	golang.org/x/text v0.39.0 // indirect
)

require (
	github.com/adrg/xdg v0.5.3 // indirect
	github.com/go-ole/go-ole v1.3.0 // indirect
	github.com/godbus/dbus/v5 v5.2.2 // indirect
	github.com/jchv/go-winloader v0.0.0-20250406163304-c1995be93bd1 // indirect
	github.com/mattn/go-colorable v0.1.14 // indirect
	github.com/mattn/go-isatty v0.0.20 // indirect
	github.com/wailsapp/wails/v3 v3.0.0-beta.12
)

replace convenewire.dev/contracts => ../packages/contracts

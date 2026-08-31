package runtime

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestCodexFilesystemPermissionProfileProbeRequiresPhysicalBoundary(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("native macOS probe")
	}
	for _, mode := range []string{"safe", "read-escape", "write-escape", "profile-missing", "profile-duplicate", "profile-broadened", "malformed-protocol"} {
		t.Run(mode, func(t *testing.T) {
			workspace, outside := permissionProbeDirectories(t)
			result, err := ProbeCodexFilesystemPermissionProfile(context.Background(), fakePermissionProbe(t, workspace, outside, mode), time.Date(2026, 9, 1, 4, 0, 0, 0, time.UTC))
			if mode == "safe" {
				if err != nil {
					t.Fatal(err)
				}
				if result.PermissionProfile != "convenewire_test" || len(result.ExecutableDigest) != 64 || len(result.PermissionProfileDigest) != 64 || result.ProbedAt != "2026-09-01T04:00:00Z" || result.Platform == "" {
					t.Fatalf("result=%+v", result)
				}
			} else if !errors.Is(err, ErrCodexPermissionBoundary) {
				t.Fatalf("mode=%s error=%v", mode, err)
			}
			entries, err := os.ReadDir(outside)
			if err != nil || len(entries) != 0 {
				t.Fatalf("outside residue: %v %v", entries, err)
			}
			inside, err := filepath.Glob(filepath.Join(workspace, ".convenewire-permission-probe-*"))
			if err != nil || len(inside) != 0 {
				t.Fatalf("workspace residue: %v %v", inside, err)
			}
		})
	}
}

func TestCodexFilesystemPermissionProfileProbeRejectsUnboundedLocalInputs(t *testing.T) {
	workspace, outside := permissionProbeDirectories(t)
	base := fakePermissionProbe(t, workspace, outside, "safe")
	for name, change := range map[string]func(*CodexFilesystemPermissionProbe){
		"unknown profile":       func(v *CodexFilesystemPermissionProbe) { v.PermissionProfile = ":workspace" },
		"unsafe environment":    func(v *CodexFilesystemPermissionProbe) { v.Environment = []string{"OPENAI_API_KEY=secret"} },
		"sandbox marker":        func(v *CodexFilesystemPermissionProbe) { v.Environment = []string{"CODEX_SANDBOX=seatbelt"} },
		"duplicate environment": func(v *CodexFilesystemPermissionProbe) { v.Environment = []string{"HOME=/one", "HOME=/two"} },
		"short timeout":         func(v *CodexFilesystemPermissionProbe) { v.Timeout = time.Millisecond },
		"long timeout":          func(v *CodexFilesystemPermissionProbe) { v.Timeout = 2 * time.Minute },
		"relative workspace":    func(v *CodexFilesystemPermissionProbe) { v.Workspace = "." },
		"overlap":               func(v *CodexFilesystemPermissionProbe) { v.OutsideRoot = v.Workspace },
		"non-codex executable": func(v *CodexFilesystemPermissionProbe) {
			v.Command = append([]string{}, v.Command...)
			v.Command[0] = os.Args[0]
		},
		"missing stdio": func(v *CodexFilesystemPermissionProbe) {
			v.Command = []string{v.Command[0], "app-server"}
		},
		"duplicate app server": func(v *CodexFilesystemPermissionProbe) {
			v.Command = []string{v.Command[0], "app-server", "app-server", "--listen", "stdio://"}
		},
		"duplicate stdio": func(v *CodexFilesystemPermissionProbe) {
			v.Command = []string{v.Command[0], "app-server", "--listen", "stdio://", "--listen", "stdio://"}
		},
		"unsafe command": func(v *CodexFilesystemPermissionProbe) {
			v.Command = []string{v.Command[0], "app-server", "--listen", "stdio://", "--dangerously-bypass-approvals-and-sandbox"}
		},
	} {
		t.Run(name, func(t *testing.T) {
			value := base
			change(&value)
			if _, err := ProbeCodexFilesystemPermissionProfile(context.Background(), value, time.Now()); !errors.Is(err, ErrCodexPermissionProfileUnsupported) {
				t.Fatal(err)
			}
		})
	}
	link := filepath.Join(filepath.Dir(outside), "outside-link")
	if err := os.Symlink(outside, link); err == nil {
		value := base
		value.OutsideRoot = link
		if _, err := ProbeCodexFilesystemPermissionProfile(context.Background(), value, time.Now()); !errors.Is(err, ErrCodexPermissionProfileUnsupported) {
			t.Fatal(err)
		}
	}
}

func TestCodexPermissionDefinitionIsClosedAndNonNetworked(t *testing.T) {
	if !strictCodexPermissionDefinition(fakePermissionDefinition(false)) {
		t.Fatal("closed profile rejected")
	}
	for _, raw := range [][]byte{
		fakePermissionDefinition(true),
		[]byte(`{"extends":null,"workspace_roots":null,"filesystem":{":root":"read",":minimal":"read",":tmpdir":"deny",":slash_tmp":"deny",":workspace_roots":{".":"write"}},"network":{"enabled":false}}`),
		[]byte(`{"extends":null,"workspace_roots":{"/private":"write"},"filesystem":{":root":"deny",":minimal":"read",":tmpdir":"deny",":slash_tmp":"deny",":workspace_roots":{".":"write"}},"network":{"enabled":false}}`),
		[]byte(`{"extends":null,"workspace_roots":null,"filesystem":{":root":"deny",":minimal":"read",":tmpdir":"deny",":slash_tmp":"deny",":workspace_roots":{".":"write","other":"write"}},"network":{"enabled":false}}`),
		[]byte(`{"extends":null,"workspace_roots":null,"filesystem":{":root":"deny",":minimal":"read",":tmpdir":"deny",":slash_tmp":"deny",":workspace_roots":{".":"write"},"/extra":"read"},"network":{"enabled":false}}`),
		[]byte(`{"extends":null,"workspace_roots":null,"filesystem":{":root":"deny",":minimal":"read",":tmpdir":"deny",":slash_tmp":"deny",":workspace_roots":{".":"write"}},"network":{"enabled":false},"unknown":true}`),
	} {
		if strictCodexPermissionDefinition(raw) {
			t.Fatalf("broadened profile accepted: %s", raw)
		}
	}
}

func permissionProbeDirectories(t *testing.T) (string, string) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	workspace, outside := filepath.Join(root, "workspace"), filepath.Join(root, "outside")
	for _, path := range []string{workspace, outside} {
		if err := os.Mkdir(path, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	return workspace, outside
}

func fakePermissionProbe(t *testing.T, workspace, outside, mode string) CodexFilesystemPermissionProbe {
	t.Helper()
	executable := filepath.Join(filepath.Dir(workspace), "codex")
	if err := os.Link(os.Args[0], executable); err != nil {
		t.Fatal(err)
	}
	return CodexFilesystemPermissionProbe{Command: []string{executable, "-test.run=TestCodexPermissionProfileHelperProcess", "--", "app-server", "--listen", "stdio://", "mode=" + mode},
		Workspace: workspace, OutsideRoot: outside, PermissionProfile: "convenewire_test", Timeout: 5 * time.Second}
}

func fakePermissionDefinition(network bool) []byte {
	value := map[string]any{"description": nil, "extends": nil, "workspace_roots": nil,
		"filesystem": map[string]any{"glob_scan_max_depth": nil, ":root": "deny", ":minimal": "read", ":tmpdir": "deny", ":slash_tmp": "deny", ":workspace_roots": map[string]string{".": "write"}},
		"network":    map[string]any{"enabled": network, "domains": nil}}
	raw, _ := json.Marshal(value)
	return raw
}

func TestCodexPermissionProfileHelperProcess(t *testing.T) {
	mode := ""
	for _, arg := range os.Args {
		if strings.HasPrefix(arg, "mode=") {
			mode = strings.TrimPrefix(arg, "mode=")
		}
	}
	if mode == "" {
		return
	}
	reader, writer := bufio.NewScanner(os.Stdin), json.NewEncoder(os.Stdout)
	for reader.Scan() {
		var request struct {
			ID     int             `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if json.Unmarshal(reader.Bytes(), &request) != nil || request.ID == 0 {
			continue
		}
		if mode == "malformed-protocol" {
			_, _ = os.Stdout.WriteString("not-json\n")
			return
		}
		result := any(map[string]any{})
		switch request.Method {
		case "permissionProfile/list":
			data := []map[string]any{{"id": "convenewire_test", "allowed": true}}
			if mode == "profile-missing" {
				data = []map[string]any{}
			} else if mode == "profile-duplicate" {
				data = append(data, map[string]any{"id": "convenewire_test", "allowed": false})
			}
			result = map[string]any{"data": data, "nextCursor": nil}
		case "config/read":
			result = map[string]any{"config": map[string]any{"permissions": map[string]any{"convenewire_test": json.RawMessage(fakePermissionDefinition(mode == "profile-broadened"))}}}
		case "command/exec":
			var params struct {
				Command []string `json:"command"`
				Cwd     string   `json:"cwd"`
			}
			_ = json.Unmarshal(request.Params, &params)
			exit, stdout := 1, ""
			if len(params.Command) > 0 && params.Command[0] == "/bin/sh" {
				target := params.Command[len(params.Command)-1]
				inside := filepath.Dir(target) == params.Cwd
				if inside || mode == "write-escape" {
					content := "forbidden"
					if inside {
						content = "permitted"
					}
					if os.WriteFile(target, []byte(content), 0o600) == nil {
						exit = 0
					}
				}
			} else if len(params.Command) > 1 && params.Command[0] == "/bin/cat" && mode == "read-escape" {
				raw, _ := os.ReadFile(params.Command[1])
				stdout, exit = string(raw), 0
			}
			result = map[string]any{"exitCode": exit, "stdout": stdout, "stderr": ""}
		}
		_ = writer.Encode(map[string]any{"id": request.ID, "result": result})
	}
}

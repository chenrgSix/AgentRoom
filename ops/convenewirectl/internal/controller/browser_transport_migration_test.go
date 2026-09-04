package controller

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type browserMigrationFixture struct {
	control      *Controller
	dataRoot     string
	installation Installation
	runner       *fakeRunner
	failLAN      *bool
	failHTTPS    *bool
	staleCommit  *bool
}

func newBrowserMigrationFixture(t *testing.T) browserMigrationFixture {
	t.Helper()
	root := t.TempDir()
	releaseDir := createRelease(t, root, "v1.2.3", 1)
	dataRoot := filepath.Join(root, "state")
	now := time.Date(2026, 8, 28, 1, 2, 3, 0, time.UTC)
	runner := &fakeRunner{failOnce: map[string]int{}}
	runner.hook = func(command Command) {
		if !strings.Contains(command.Name+" "+strings.Join(command.Args, " "), " up ") {
			return
		}
		manifest, found, err := loadManifest(installationPaths(dataRoot).ManifestPath)
		if err != nil || !found {
			t.Fatalf("load migration manifest: found=%v err=%v", found, err)
		}
		caPath := privateCARootPath(manifest, activePrivateCAID(manifest))
		if _, err := os.Stat(caPath); errors.Is(err, os.ErrNotExist) {
			writeTestCA(t, caPath, now)
		}
	}
	failLAN := false
	failHTTPS := false
	staleCommit := false
	lanReadiness := 0
	dependencies := testDependencies(runner, &bytes.Buffer{})
	dependencies.CheckReadiness = func(_ context.Context, input ReadinessInput) error {
		if failHTTPS && strings.HasPrefix(input.PublicOrigin, "https://") {
			return errors.New("injected HTTPS Bridge failure")
		}
		if failLAN && strings.HasPrefix(input.BrowserOrigin, "http://") {
			return errors.New("injected LAN browser failure")
		}
		if staleCommit && strings.HasPrefix(input.BrowserOrigin, "http://") {
			lanReadiness++
			if lanReadiness == 2 {
				current, found, err := loadManifest(installationPaths(dataRoot).ManifestPath)
				if err != nil || !found {
					t.Fatalf("load manifest for stale injection: found=%v err=%v", found, err)
				}
				current.Generation++
				if err := saveManifest(installationPaths(dataRoot).ManifestPath, current); err != nil {
					t.Fatal(err)
				}
			}
		}
		return nil
	}
	control := New(dependencies)
	options := installOptions(releaseDir, dataRoot)
	options.Mode = "direct_https"
	options.TLSProfile = "private_scoped_ca"
	options.Domain = "central.local"
	options.PublicOrigin = "https://central.local:19443"
	installation, err := control.Install(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	return browserMigrationFixture{control: control, dataRoot: dataRoot, installation: installation,
		runner: runner, failLAN: &failLAN, failHTTPS: &failHTTPS, staleCommit: &staleCommit}
}

func TestBrowserTransportMigrationRoundTripsWithoutChangingPrivateAuthorityOrData(t *testing.T) {
	fixture := newBrowserMigrationFixture(t)
	marker := filepath.Join(fixture.dataRoot, "data", "owner-data")
	if err := os.WriteFile(marker, []byte("preserved"), 0o600); err != nil {
		t.Fatal(err)
	}
	originalCA, err := os.ReadFile(fixture.installation.TrustCAPEMPath)
	if err != nil {
		t.Fatal(err)
	}
	originalDigest := fixture.installation.Manifest.CACertificateSHA256

	if err := fixture.control.MigrateBrowserTransport(context.Background(), BrowserTransportMigrationOptions{
		DataRoot: fixture.dataRoot, Mode: "lan_http",
	}); err != nil {
		t.Fatal(err)
	}
	lan, found, err := loadManifest(fixture.installation.ManifestPath)
	if err != nil || !found {
		t.Fatalf("load LAN manifest: found=%v err=%v", found, err)
	}
	if lan.Mode != "lan_http" || lan.TLSProfile != "private_scoped_ca" ||
		lan.CACertificateSHA256 != originalDigest || lan.InstallationID != fixture.installation.Manifest.InstallationID {
		t.Fatalf("LAN migration changed private authority: %+v", lan)
	}
	environment, _ := os.ReadFile(fixture.installation.EnvironmentPath)
	if !bytes.Contains(environment, []byte(`CONVENE_WIRE_BROWSER_ORIGIN="http://central.local:19080"`)) ||
		!bytes.Contains(environment, []byte("deploy/http/lan-app.caddy")) {
		t.Fatalf("LAN control files are incomplete:\n%s", environment)
	}

	if err := fixture.control.MigrateBrowserTransport(context.Background(), BrowserTransportMigrationOptions{
		DataRoot: fixture.dataRoot, Mode: "direct_https",
	}); err != nil {
		t.Fatal(err)
	}
	direct, found, err := loadManifest(fixture.installation.ManifestPath)
	if err != nil || !found || direct.Mode != "direct_https" || direct.CACertificateSHA256 != originalDigest {
		t.Fatalf("HTTPS migration did not preserve authority: found=%v manifest=%+v err=%v", found, direct, err)
	}
	currentCA, _ := os.ReadFile(fixture.installation.TrustCAPEMPath)
	data, _ := os.ReadFile(marker)
	if !bytes.Equal(currentCA, originalCA) || string(data) != "preserved" {
		t.Fatal("browser transport round trip changed CA or owner data")
	}
	if roots, _ := filepath.Glob(filepath.Join(fixture.dataRoot, "control", ".browser-transport-*")); len(roots) != 0 {
		t.Fatalf("migration left isolated roots: %v", roots)
	}
}

func TestBrowserTransportMigrationRestoresFilesTopologyAndManifestAfterReadinessFailure(t *testing.T) {
	fixture := newBrowserMigrationFixture(t)
	beforeEnvironment, _ := os.ReadFile(fixture.installation.EnvironmentPath)
	beforeOverride, _ := os.ReadFile(fixture.installation.OverridePath)
	*fixture.failLAN = true
	err := fixture.control.MigrateBrowserTransport(context.Background(), BrowserTransportMigrationOptions{
		DataRoot: fixture.dataRoot, Mode: "lan_http",
	})
	requireActionCode(t, err, "BROWSER_TRANSPORT_MIGRATION_FAILED")
	manifest, found, loadErr := loadManifest(fixture.installation.ManifestPath)
	if loadErr != nil || !found || manifest.Mode != "direct_https" {
		t.Fatalf("failed migration committed its candidate: found=%v manifest=%+v err=%v", found, manifest, loadErr)
	}
	afterEnvironment, _ := os.ReadFile(fixture.installation.EnvironmentPath)
	afterOverride, _ := os.ReadFile(fixture.installation.OverridePath)
	if !bytes.Equal(beforeEnvironment, afterEnvironment) || !bytes.Equal(beforeOverride, afterOverride) {
		t.Fatal("failed migration did not restore exact generated control files")
	}
	if roots, _ := filepath.Glob(filepath.Join(fixture.dataRoot, "control", ".browser-transport-*")); len(roots) != 0 {
		t.Fatalf("failed migration left isolated roots: %v", roots)
	}
}

func TestBrowserTransportMigrationNeverMutatesWhenCurrentHTTPSIsUnready(t *testing.T) {
	fixture := newBrowserMigrationFixture(t)
	beforeEnvironment, _ := os.ReadFile(fixture.installation.EnvironmentPath)
	*fixture.failHTTPS = true
	err := fixture.control.MigrateBrowserTransport(context.Background(), BrowserTransportMigrationOptions{
		DataRoot: fixture.dataRoot, Mode: "lan_http",
	})
	requireActionCode(t, err, "BROWSER_TRANSPORT_CURRENT_UNREADY")
	afterEnvironment, _ := os.ReadFile(fixture.installation.EnvironmentPath)
	manifest, _, _ := loadManifest(fixture.installation.ManifestPath)
	if manifest.Mode != "direct_https" || !bytes.Equal(beforeEnvironment, afterEnvironment) {
		t.Fatal("current HTTPS failure entered transport mutation")
	}
}

func TestBrowserTransportMigrationRejectsUnknownTargetWithoutMutation(t *testing.T) {
	fixture := newBrowserMigrationFixture(t)
	beforeEnvironment, _ := os.ReadFile(fixture.installation.EnvironmentPath)
	err := fixture.control.MigrateBrowserTransport(context.Background(), BrowserTransportMigrationOptions{
		DataRoot: fixture.dataRoot, Mode: "public_http",
	})
	requireActionCode(t, err, "BROWSER_TRANSPORT_INVALID")
	afterEnvironment, _ := os.ReadFile(fixture.installation.EnvironmentPath)
	if !bytes.Equal(beforeEnvironment, afterEnvironment) {
		t.Fatal("invalid target changed generated control files")
	}
}

func TestBrowserTransportMigrationRollsBackStartAndStaleManifestFailures(t *testing.T) {
	for _, test := range []struct {
		name      string
		configure func(browserMigrationFixture)
	}{
		{name: "candidate start", configure: func(fixture browserMigrationFixture) {
			fixture.runner.failOnce[" up "] = 1
		}},
		{name: "manifest compare and swap", configure: func(fixture browserMigrationFixture) {
			*fixture.staleCommit = true
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newBrowserMigrationFixture(t)
			beforeEnvironment, _ := os.ReadFile(fixture.installation.EnvironmentPath)
			beforeOverride, _ := os.ReadFile(fixture.installation.OverridePath)
			test.configure(fixture)
			err := fixture.control.MigrateBrowserTransport(context.Background(), BrowserTransportMigrationOptions{
				DataRoot: fixture.dataRoot, Mode: "lan_http",
			})
			requireActionCode(t, err, "BROWSER_TRANSPORT_MIGRATION_FAILED")
			manifest, found, loadErr := loadManifest(fixture.installation.ManifestPath)
			if loadErr != nil || !found || manifest.Mode != "direct_https" {
				t.Fatalf("failed migration changed manifest: found=%v manifest=%+v err=%v", found, manifest, loadErr)
			}
			afterEnvironment, _ := os.ReadFile(fixture.installation.EnvironmentPath)
			afterOverride, _ := os.ReadFile(fixture.installation.OverridePath)
			if !bytes.Equal(beforeEnvironment, afterEnvironment) || !bytes.Equal(beforeOverride, afterOverride) {
				t.Fatal("failed migration did not restore exact control files")
			}
		})
	}
}

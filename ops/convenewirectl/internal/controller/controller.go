package controller

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	legacyManifestSchemaVersion = 1
	manifestSchemaVersion       = 2
	releaseSchemaVersion        = 1
	minimumFreeBytes            = 1 << 30
	defaultReadyTimeout         = 3 * time.Minute
)

var (
	releasePattern     = regexp.MustCompile(`^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$`)
	hashPattern        = regexp.MustCompile(`^[0-9a-f]{64}$`)
	installIDPattern   = regexp.MustCompile(`^install_[A-Za-z0-9_-]{16,128}$`)
	privateCAIDPattern = regexp.MustCompile(`^(?:local|(?:agentroom|convenewire)-[0-9]+-[0-9a-f]{16})$`)
	domainPattern      = regexp.MustCompile(`^[A-Za-z0-9.-]+$`)
	commitPattern      = regexp.MustCompile(`^[0-9a-f]{40,64}$`)
)

type ActionError struct {
	Code    string
	Message string
	Hint    string
	Cause   error
}

func (err *ActionError) Error() string {
	if err.Cause == nil {
		return fmt.Sprintf("%s: %s", err.Code, err.Message)
	}
	return fmt.Sprintf("%s: %s: %v", err.Code, err.Message, err.Cause)
}

func (err *ActionError) Unwrap() error { return err.Cause }

func actionError(code, message, hint string, cause error) error {
	return &ActionError{Code: code, Message: message, Hint: hint, Cause: cause}
}

type Command struct {
	Dir  string
	Env  map[string]string
	Name string
	Args []string
}

type Runner interface {
	Run(context.Context, Command) (string, error)
}

type ExecRunner struct{}

func (ExecRunner) Run(ctx context.Context, command Command) (string, error) {
	cmd := exec.CommandContext(ctx, command.Name, command.Args...)
	cmd.Dir = command.Dir
	environment := make(map[string]string)
	for _, value := range os.Environ() {
		key, _, found := strings.Cut(value, "=")
		if found {
			environment[key] = value
		}
	}
	for key, value := range command.Env {
		environment[key] = key + "=" + value
	}
	keys := make([]string, 0, len(environment))
	for key := range environment {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	cmd.Env = make([]string, 0, len(keys))
	for _, key := range keys {
		cmd.Env = append(cmd.Env, environment[key])
	}
	output, err := cmd.CombinedOutput()
	cleanOutput := redactCommandOutput(string(output), command.Env)
	if err != nil {
		detail := strings.TrimSpace(cleanOutput)
		if len(detail) > 4_000 {
			detail = detail[:4_000] + "..."
		}
		if detail != "" {
			return cleanOutput, fmt.Errorf("%s %s: %w: %s", command.Name, strings.Join(command.Args, " "), err, detail)
		}
		return cleanOutput, fmt.Errorf("%s %s: %w", command.Name, strings.Join(command.Args, " "), err)
	}
	return cleanOutput, nil
}

type PortChecker func(bindAddress string, ports ...int) error
type FreeSpaceChecker func(path string) (uint64, error)
type ReadinessChecker func(context.Context, ReadinessInput) error

type Dependencies struct {
	Runner         Runner
	GOOS           string
	GOARCH         string
	Random         io.Reader
	Now            func() time.Time
	CheckPorts     PortChecker
	FreeSpace      FreeSpaceChecker
	CheckReadiness ReadinessChecker
	Output         io.Writer
}

func DefaultDependencies(output io.Writer) Dependencies {
	return Dependencies{
		Runner:         ExecRunner{},
		GOOS:           runtime.GOOS,
		GOARCH:         runtime.GOARCH,
		Random:         rand.Reader,
		Now:            time.Now,
		CheckPorts:     checkPorts,
		FreeSpace:      freeSpace,
		CheckReadiness: checkReadiness,
		Output:         output,
	}
}

type InstallOptions struct {
	ReleaseDir        string
	ChecksumsPath     string
	ChecksumsSHA256   string
	DataRoot          string
	Mode              string
	TLSProfile        string
	Domain            string
	PublicOrigin      string
	HTTPPort          int
	HTTPSPort         int
	LegacyServerToken bool
	ProjectName       string
}

type ReleaseMetadata struct {
	SchemaVersion     int    `json:"schemaVersion"`
	ReleaseVersion    string `json:"releaseVersion"`
	DataSchemaVersion int    `json:"dataSchemaVersion"`
	SourceCommit      string `json:"sourceCommit"`
	TargetOS          string `json:"targetOS"`
	TargetArch        string `json:"targetArch"`
}

type Manifest struct {
	SchemaVersion       int    `json:"schemaVersion"`
	ReleaseVersion      string `json:"releaseVersion"`
	ReleaseDir          string `json:"releaseDir"`
	ReleaseDigest       string `json:"releaseDigest"`
	DataSchemaVersion   int    `json:"dataSchemaVersion"`
	DataRoot            string `json:"dataRoot"`
	Mode                string `json:"mode"`
	TLSProfile          string `json:"tlsProfile,omitempty"`
	InstallationID      string `json:"installationId,omitempty"`
	TrustEpoch          int    `json:"trustEpoch,omitempty"`
	CACertificateSHA256 string `json:"caCertificateSha256,omitempty"`
	PrivateCAID         string `json:"privateCaId,omitempty"`
	Domain              string `json:"domain"`
	PublicOrigin        string `json:"publicOrigin"`
	HTTPPort            int    `json:"httpPort"`
	HTTPSPort           int    `json:"httpsPort"`
	LegacyServerToken   bool   `json:"legacyServerToken"`
	ProjectName         string `json:"projectName"`
	LastSuccessfulStep  string `json:"lastSuccessfulStep"`
	InstalledAt         string `json:"installedAt"`
	UpdatedAt           string `json:"updatedAt"`
}

type Installation struct {
	ManifestPath        string
	EnvironmentPath     string
	OverridePath        string
	OwnerSecretPath     string
	ServerSecretPath    string
	TrustDirectory      string
	TrustDescriptorPath string
	TrustCAPEMPath      string
	TrustRotationPath   string
	RotationJournalPath string
	CaddyTLSProfilePath string
	CaddyPKIProfilePath string
	Manifest            Manifest
}

type ReadinessInput struct {
	PublicOrigin     string
	LocalCARoot      string
	TLSProfile       string
	ExpectedCADigest string
	Timeout          time.Duration
}

type deploymentTrustDescriptor struct {
	SchemaVersion       int    `json:"schemaVersion"`
	Mode                string `json:"mode"`
	Origin              string `json:"origin"`
	InstallationID      string `json:"installationId"`
	TrustEpoch          int    `json:"trustEpoch"`
	CACertificateSHA256 string `json:"caCertificateSha256"`
}

type Controller struct {
	dependencies Dependencies
}

func New(dependencies Dependencies) *Controller {
	if dependencies.Runner == nil {
		dependencies.Runner = ExecRunner{}
	}
	if dependencies.Random == nil {
		dependencies.Random = rand.Reader
	}
	if dependencies.Now == nil {
		dependencies.Now = time.Now
	}
	if dependencies.CheckPorts == nil {
		dependencies.CheckPorts = checkPorts
	}
	if dependencies.FreeSpace == nil {
		dependencies.FreeSpace = freeSpace
	}
	if dependencies.CheckReadiness == nil {
		dependencies.CheckReadiness = checkReadiness
	}
	if dependencies.Output == nil {
		dependencies.Output = io.Discard
	}
	return &Controller{dependencies: dependencies}
}

func (controller *Controller) Install(ctx context.Context, raw InstallOptions) (Installation, error) {
	options, err := controller.normalizeInstallOptions(raw)
	if err != nil {
		return Installation{}, err
	}
	if err := controller.validateHost(ctx); err != nil {
		return Installation{}, err
	}
	metadata, digest, err := verifyRelease(
		options.ReleaseDir,
		options.ChecksumsPath,
		options.ChecksumsSHA256,
	)
	if err != nil {
		return Installation{}, err
	}
	if metadata.TargetOS != controller.dependencies.GOOS || metadata.TargetArch != controller.dependencies.GOARCH {
		return Installation{}, actionError(
			"RELEASE_TARGET_MISMATCH",
			fmt.Sprintf("release targets %s/%s but this host is %s/%s", metadata.TargetOS, metadata.TargetArch, controller.dependencies.GOOS, controller.dependencies.GOARCH),
			"Use the central release archive published for this host operating system and architecture.",
			nil,
		)
	}
	installation := installationPaths(options.DataRoot)
	existing, exists, err := loadManifest(installation.ManifestPath)
	if err != nil {
		return Installation{}, err
	}
	options, err = resolveInstallTLSProfile(options, existing, exists)
	if err != nil {
		return Installation{}, err
	}
	if exists {
		if err := matchInstall(existing, options, metadata, digest); err != nil {
			return Installation{}, err
		}
	} else if dataRootHasState(options.DataRoot) {
		return Installation{}, actionError(
			"EXISTING_DATA_WITHOUT_MANIFEST",
			"the selected data root is not empty and has no ConveneWire installation manifest",
			"Choose an empty data root or recover the original installation manifest; automatic adoption is intentionally disabled.",
			nil,
		)
	}
	bindAddress := "0.0.0.0"
	if options.Mode == "local" {
		bindAddress = "127.0.0.1"
	}
	if !exists || existing.LastSuccessfulStep == "uninstalled" {
		if err := controller.dependencies.CheckPorts(bindAddress, options.HTTPPort, options.HTTPSPort); err != nil {
			return Installation{}, actionError(
				"PORT_UNAVAILABLE",
				"an ConveneWire ingress port is unavailable",
				"Stop the process that owns the reported port or select different HTTP and HTTPS ports.",
				err,
			)
		}
	}
	if err := ensureBootstrapDirectories(options.DataRoot); err != nil {
		return Installation{}, actionError(
			"STORAGE_PREPARE_FAILED",
			"could not prepare the installation control directory",
			"Check ownership and permissions on the parent directory; ConveneWire will not widen them automatically.",
			err,
		)
	}
	free, err := controller.dependencies.FreeSpace(options.DataRoot)
	if err != nil {
		return Installation{}, actionError("STORAGE_CHECK_FAILED", "could not inspect free storage", "Check the data-root filesystem and retry.", err)
	}
	if free < minimumFreeBytes {
		return Installation{}, actionError(
			"STORAGE_LOW",
			fmt.Sprintf("the selected data root has %d bytes free; at least %d are required", free, minimumFreeBytes),
			"Free storage or select a different data root before installation.",
			nil,
		)
	}
	now := controller.dependencies.Now().UTC().Format(time.RFC3339Nano)
	manifest := existing
	if !exists {
		installationID, err := newInstallationID(controller.dependencies.Random)
		if err != nil {
			return Installation{}, actionError("INSTALLATION_ID_FAILED", "could not generate the stable installation identity", "Check the host random source and retry before starting services.", err)
		}
		trustEpoch := 0
		if options.TLSProfile == "private_scoped_ca" {
			trustEpoch = 1
		}
		manifest = Manifest{
			SchemaVersion: manifestSchemaVersion, ReleaseVersion: metadata.ReleaseVersion,
			ReleaseDir: options.ReleaseDir, ReleaseDigest: digest,
			DataSchemaVersion: metadata.DataSchemaVersion, DataRoot: options.DataRoot,
			Mode: options.Mode, TLSProfile: options.TLSProfile,
			InstallationID: installationID, TrustEpoch: trustEpoch,
			Domain: options.Domain, PublicOrigin: options.PublicOrigin,
			HTTPPort: options.HTTPPort, HTTPSPort: options.HTTPSPort,
			LegacyServerToken:  options.LegacyServerToken,
			ProjectName:        options.ProjectName,
			LastSuccessfulStep: "release_verified", InstalledAt: now, UpdatedAt: now,
		}
		if options.TLSProfile == "private_scoped_ca" {
			manifest.PrivateCAID = privateCAID(installationID, trustEpoch)
		}
		if err := saveManifest(installation.ManifestPath, manifest); err != nil {
			return Installation{}, actionError("MANIFEST_WRITE_FAILED", "could not atomically establish the installation manifest", "Repair the selected data-root permissions and retry the exact command; an empty control directory is safe to reuse.", err)
		}
	}
	installation.Manifest = manifest
	if err := ensureDirectories(options.DataRoot); err != nil {
		return Installation{}, actionError(
			"STORAGE_PREPARE_FAILED",
			"could not prepare the selected data root",
			"Check ownership and permissions on the data root; the recorded installation is safe to retry.",
			err,
		)
	}
	if err := controller.recordStep(&manifest, installation.ManifestPath, "storage_ready"); err != nil {
		return Installation{}, err
	}
	if err := ensureSecret(installation.OwnerSecretPath, controller.dependencies.Random); err != nil {
		return Installation{}, actionError("SECRET_PREPARE_FAILED", "could not prepare the Owner recovery secret", "Check the data-root permissions; never replace an existing recovery secret manually.", err)
	}
	if options.LegacyServerToken {
		if err := ensureSecret(installation.ServerSecretPath, controller.dependencies.Random); err != nil {
			return Installation{}, actionError("SECRET_PREPARE_FAILED", "could not prepare the legacy Server Token", "Check the data-root permissions and retry without printing the secret.", err)
		}
	}
	if err := controller.recordStep(&manifest, installation.ManifestPath, "secrets_ready"); err != nil {
		return Installation{}, err
	}
	if err := renderConfiguration(options, metadata.ReleaseVersion, installation); err != nil {
		return Installation{}, actionError("CONFIG_RENDER_FAILED", "could not render atomic installation configuration", "Check the control-directory permissions and retry.", err)
	}
	if err := controller.recordStep(&manifest, installation.ManifestPath, "configuration_ready"); err != nil {
		return Installation{}, err
	}
	commandEnvironment, err := installationEnvironment(installation)
	if err != nil {
		return Installation{}, err
	}
	if _, err := controller.runCompose(ctx, installation, commandEnvironment, "config", "--quiet"); err != nil {
		return Installation{}, actionError("COMPOSE_INVALID", "Docker Compose rejected the complete ConveneWire model", "Inspect the reported Compose error; generated secrets and data were preserved for an exact retry.", err)
	}
	if err := controller.recordStep(&manifest, installation.ManifestPath, "compose_validated"); err != nil {
		return Installation{}, err
	}
	if _, err := controller.runCompose(ctx, installation, commandEnvironment,
		"up", "-d", "--build", "--wait", "--wait-timeout", "180"); err != nil {
		return Installation{}, actionError("SERVICES_START_FAILED", "ConveneWire services did not reach the Compose running boundary", "Run convenewirectl doctor for bounded service and log guidance, then retry install with the same arguments.", err)
	}
	if err := controller.recordStep(&manifest, installation.ManifestPath, "services_started"); err != nil {
		return Installation{}, err
	}
	if options.TLSProfile == "private_scoped_ca" {
		digest, err := publishPrivateTrust(installation, manifest, controller.dependencies.Now())
		if err != nil {
			return Installation{}, actionError("PRIVATE_TRUST_INVALID", "the scoped private CA could not be verified and published", "Inspect Caddy startup and local PKI state; do not copy or install a root manually. Retry the exact install command after correcting Caddy.", err)
		}
		if manifest.CACertificateSHA256 != "" && manifest.CACertificateSHA256 != digest {
			return Installation{}, actionError("PRIVATE_CA_CHANGED", "the active private CA differs from the installation manifest", "Do not overwrite the pin or fall back. Restore the recorded Caddy state or perform an authenticated overlap rotation.", nil)
		}
		manifest.CACertificateSHA256 = digest
		if err := controller.recordStep(&manifest, installation.ManifestPath, "private_trust_ready"); err != nil {
			return Installation{}, err
		}
	}
	readiness := ReadinessInput{
		PublicOrigin:     options.PublicOrigin,
		LocalCARoot:      privateCARootPath(manifest, activePrivateCAID(manifest)),
		TLSProfile:       options.TLSProfile,
		ExpectedCADigest: manifest.CACertificateSHA256,
		Timeout:          defaultReadyTimeout,
	}
	if err := controller.dependencies.CheckReadiness(ctx, readiness); err != nil {
		return Installation{}, actionError("READINESS_FAILED", "the public HTTPS origin did not pass readiness and WebSocket checks", "Check DNS, certificate trust, port forwarding, public origin agreement, and Caddy/ConveneWire logs; the same install command is safe to retry.", err)
	}
	if err := controller.recordStep(&manifest, installation.ManifestPath, "ready"); err != nil {
		return Installation{}, err
	}
	installation.Manifest = manifest
	trustSummary := options.TLSProfile
	if manifest.CACertificateSHA256 != "" {
		trustSummary += " (CA " + redactedDigest(manifest.CACertificateSHA256) + ")"
	}
	fmt.Fprintf(controller.dependencies.Output,
		"ConveneWire %s is ready at %s\nData root: %s\nOwner recovery file: %s\nTLS profile: %s\nInstallation ID: %s\nNext: open the origin and claim the Owner using the recovery file.\n",
		manifest.ReleaseVersion, manifest.PublicOrigin, manifest.DataRoot,
		installation.OwnerSecretPath, trustSummary, manifest.InstallationID,
	)
	return installation, nil
}

func (controller *Controller) normalizeInstallOptions(raw InstallOptions) (InstallOptions, error) {
	options := raw
	var err error
	options.ReleaseDir, err = filepath.Abs(strings.TrimSpace(options.ReleaseDir))
	if err != nil {
		return InstallOptions{}, actionError("RELEASE_PATH_INVALID", "release directory is invalid", "Pass an absolute path to an extracted checksum-pinned central release.", err)
	}
	options.DataRoot, err = filepath.Abs(strings.TrimSpace(options.DataRoot))
	if err != nil {
		return InstallOptions{}, actionError("DATA_ROOT_INVALID", "data root is invalid", "Pass an absolute persistent data-root path.", err)
	}
	if options.ChecksumsPath == "" {
		options.ChecksumsPath = filepath.Join(options.ReleaseDir, "SHA256SUMS")
	} else {
		options.ChecksumsPath, err = filepath.Abs(options.ChecksumsPath)
		if err != nil {
			return InstallOptions{}, actionError("CHECKSUM_PATH_INVALID", "checksum path is invalid", "Use the SHA256SUMS shipped with the exact release.", err)
		}
	}
	if filepath.Dir(options.ChecksumsPath) != options.ReleaseDir || filepath.Base(options.ChecksumsPath) != "SHA256SUMS" {
		return InstallOptions{}, actionError("CHECKSUM_PATH_INVALID", "SHA256SUMS must belong to the extracted release root", "Use the checksum file shipped inside the exact central release directory.", nil)
	}
	options.ChecksumsSHA256 = strings.ToLower(strings.TrimSpace(options.ChecksumsSHA256))
	if !hashPattern.MatchString(options.ChecksumsSHA256) {
		return InstallOptions{}, actionError("CHECKSUM_PIN_INVALID", "a published SHA256SUMS digest is required", "Pass the 64-character SHA-256 value published separately for this exact central release.", nil)
	}
	if options.Mode != "local" && options.Mode != "direct_https" {
		return InstallOptions{}, actionError("NETWORK_MODE_INVALID", "network mode must be local or direct_https", "Use local for loopback-only access or direct_https for a stable LAN/domain origin.", nil)
	}
	options.TLSProfile = strings.TrimSpace(options.TLSProfile)
	if options.TLSProfile != "" && options.TLSProfile != "public_ca" &&
		options.TLSProfile != "private_scoped_ca" && options.TLSProfile != "manual_ca" {
		return InstallOptions{}, actionError("TLS_PROFILE_INVALID", "TLS profile must be public_ca, private_scoped_ca, or manual_ca", "Omit --tls-profile for the public default, or select the explicit private or advanced manual profile.", nil)
	}
	if options.Mode == "local" && options.TLSProfile != "" {
		return InstallOptions{}, actionError("TLS_PROFILE_INVALID", "local mode does not accept a TLS profile", "Omit --tls-profile for loopback-only local mode.", nil)
	}
	options.ProjectName = strings.TrimSpace(options.ProjectName)
	if options.ProjectName == "" {
		options.ProjectName = "agentroom"
	}
	if !validProjectName(options.ProjectName) {
		return InstallOptions{}, actionError("PROJECT_NAME_INVALID", "Compose project name is invalid", "Use 1-63 lowercase letters, digits, dashes, or underscores, beginning with a letter or digit.", nil)
	}
	if options.HTTPPort < 1 || options.HTTPPort > 65535 || options.HTTPSPort < 1 || options.HTTPSPort > 65535 || options.HTTPPort == options.HTTPSPort {
		return InstallOptions{}, actionError("PORT_INVALID", "HTTP and HTTPS ports must be distinct values from 1 to 65535", "Select two valid ingress ports.", nil)
	}
	options.Domain = strings.TrimSpace(options.Domain)
	if !validDomain(options.Domain) {
		return InstallOptions{}, actionError("DOMAIN_INVALID", "domain must be a plain host name or IPv4 address", "Remove schemes, paths, ports, spaces, and wildcard labels from --domain.", nil)
	}
	origin, err := url.Parse(strings.TrimSpace(options.PublicOrigin))
	if err != nil || origin.Scheme != "https" || origin.User != nil || origin.Hostname() == "" || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" {
		return InstallOptions{}, actionError("ORIGIN_INVALID", "public origin must be one exact HTTPS origin", "Use a value such as https://team.example.com:9443 with no path, query, fragment, or user info.", err)
	}
	if !strings.EqualFold(origin.Hostname(), options.Domain) {
		return InstallOptions{}, actionError("ORIGIN_MISMATCH", "public origin host does not match --domain", "Use the same stable host in --domain and --origin.", nil)
	}
	originPort := 443
	if origin.Port() != "" {
		originPort, err = strconv.Atoi(origin.Port())
		if err != nil {
			return InstallOptions{}, actionError("ORIGIN_INVALID", "public origin port is invalid", "Use a numeric HTTPS port.", err)
		}
	}
	if originPort != options.HTTPSPort {
		return InstallOptions{}, actionError("ORIGIN_PORT_MISMATCH", "public origin port does not match --https-port", "Keep the published HTTPS port and exact public origin aligned.", nil)
	}
	loopback := isLoopbackHost(origin.Hostname())
	if options.Mode == "local" && !loopback {
		return InstallOptions{}, actionError("LOCAL_ORIGIN_INVALID", "local mode requires a loopback origin", "Use localhost or 127.0.0.1, or select direct_https.", nil)
	}
	if options.Mode == "direct_https" && loopback {
		return InstallOptions{}, actionError("DIRECT_ORIGIN_INVALID", "direct_https requires a non-loopback stable origin", "Use the LAN IP or owned DNS name clients will verify.", nil)
	}
	options.PublicOrigin = origin.String()
	return options, nil
}

func resolveInstallTLSProfile(options InstallOptions, existing Manifest, exists bool) (InstallOptions, error) {
	if exists && existing.SchemaVersion == legacyManifestSchemaVersion {
		if options.TLSProfile != "" {
			return InstallOptions{}, actionError("TLS_PROFILE_MIGRATION_REQUIRED", "a legacy installation cannot be relabeled by install reentry", "Retry without --tls-profile. Use an explicit inspected migration after the complete scoped-trust path is available.", nil)
		}
		return options, nil
	}
	if exists && options.TLSProfile == "" {
		options.TLSProfile = existing.TLSProfile
	}
	if !exists && options.TLSProfile == "" {
		if options.Mode == "local" {
			options.TLSProfile = "local"
		} else {
			options.TLSProfile = "public_ca"
		}
	}
	if options.Mode == "local" {
		if options.TLSProfile != "local" {
			return InstallOptions{}, actionError("TLS_PROFILE_INVALID", "local installations must retain loopback-local TLS", "Omit --tls-profile for local mode.", nil)
		}
		return options, nil
	}
	if options.TLSProfile == "public_ca" && !publicCAHostname(options.Domain) {
		return InstallOptions{}, actionError("PUBLIC_CA_HOST_INVALID", "public_ca requires a DNS hostname eligible for public certificate issuance", "Use an owned public DNS hostname, or explicitly select private_scoped_ca for a private IP or name.", nil)
	}
	return options, nil
}

func (controller *Controller) validateHost(ctx context.Context) error {
	if !((controller.dependencies.GOOS == "linux" || controller.dependencies.GOOS == "darwin") &&
		(controller.dependencies.GOARCH == "amd64" || controller.dependencies.GOARCH == "arm64")) {
		return actionError("HOST_UNSUPPORTED", fmt.Sprintf("%s/%s is not a supported central host", controller.dependencies.GOOS, controller.dependencies.GOARCH), "Use Linux or macOS on amd64 or arm64; Windows is supported for the Bridge, not this central controller.", nil)
	}
	dockerVersion, err := controller.dependencies.Runner.Run(ctx, Command{
		Name: "docker", Args: []string{"version", "--format", "{{.Server.Version}}"},
	})
	if err != nil {
		return actionError("DOCKER_UNAVAILABLE", "Docker Engine is unavailable", "Install/start Docker Engine or Docker Desktop and confirm the current user can run docker version.", err)
	}
	if !versionAtLeast(strings.TrimSpace(dockerVersion), 24, 0) {
		return actionError("DOCKER_VERSION_UNSUPPORTED", "Docker Engine 24.0 or newer is required", "Upgrade Docker before installing ConveneWire.", nil)
	}
	composeVersion, err := controller.dependencies.Runner.Run(ctx, Command{
		Name: "docker", Args: []string{"compose", "version", "--short"},
	})
	if err != nil {
		return actionError("COMPOSE_UNAVAILABLE", "Docker Compose v2 is unavailable", "Install the Docker Compose v2 plugin and confirm docker compose version works.", err)
	}
	if !versionAtLeast(strings.TrimSpace(composeVersion), 2, 20) {
		return actionError("COMPOSE_VERSION_UNSUPPORTED", "Docker Compose 2.20 or newer is required", "Upgrade the Docker Compose plugin before installing ConveneWire.", nil)
	}
	return nil
}

func (controller *Controller) recordStep(manifest *Manifest, path, step string) error {
	manifest.LastSuccessfulStep = step
	manifest.UpdatedAt = controller.dependencies.Now().UTC().Format(time.RFC3339Nano)
	if err := saveManifest(path, *manifest); err != nil {
		return actionError("MANIFEST_WRITE_FAILED", "could not atomically record installation progress", "Do not start a second install; repair control-directory permissions and retry the same command.", err)
	}
	return nil
}

func (controller *Controller) runCompose(ctx context.Context, installation Installation, environment map[string]string, args ...string) (string, error) {
	composeArgs := []string{
		"compose", "--project-name", installation.Manifest.ProjectName,
		"--project-directory", installation.Manifest.ReleaseDir,
		"--env-file", installation.EnvironmentPath,
		"-f", filepath.Join(installation.Manifest.ReleaseDir, "compose.yaml"),
		"-f", installation.OverridePath,
	}
	composeArgs = append(composeArgs, args...)
	return controller.dependencies.Runner.Run(ctx, Command{
		Dir: installation.Manifest.ReleaseDir, Env: environment,
		Name: "docker", Args: composeArgs,
	})
}

func installationPaths(dataRoot string) Installation {
	control := filepath.Join(dataRoot, "control")
	trustDirectory := filepath.Join(dataRoot, "trust")
	return Installation{
		ManifestPath:        filepath.Join(control, "installation.json"),
		EnvironmentPath:     filepath.Join(control, "agentroom.env"),
		OverridePath:        filepath.Join(control, "compose.override.yaml"),
		OwnerSecretPath:     filepath.Join(dataRoot, "secrets", "owner_recovery_token"),
		ServerSecretPath:    filepath.Join(dataRoot, "secrets", "legacy_server_token"),
		TrustDirectory:      trustDirectory,
		TrustDescriptorPath: filepath.Join(trustDirectory, "deployment-trust.json"),
		TrustCAPEMPath:      filepath.Join(trustDirectory, "bridge-ca.pem"),
		TrustRotationPath:   filepath.Join(trustDirectory, "deployment-trust-rotation.json"),
		RotationJournalPath: filepath.Join(dataRoot, "control", "private-ca-rotation.json"),
		CaddyTLSProfilePath: filepath.Join(trustDirectory, "caddy-tls-profile.caddy"),
		CaddyPKIProfilePath: filepath.Join(trustDirectory, "caddy-pki-profile.caddy"),
	}
}

func ensureDirectories(dataRoot string) error {
	paths := []string{
		dataRoot,
		filepath.Join(dataRoot, "control"),
		filepath.Join(dataRoot, "data"),
		filepath.Join(dataRoot, "backups"),
		filepath.Join(dataRoot, "exports"),
		filepath.Join(dataRoot, "secrets"),
		filepath.Join(dataRoot, "prepared-secrets"),
		filepath.Join(dataRoot, "trust"),
		filepath.Join(dataRoot, "caddy", "data"),
		filepath.Join(dataRoot, "caddy", "config"),
	}
	for _, path := range paths {
		if info, err := os.Lstat(path); err == nil {
			if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("%s is not a real directory", path)
			}
			if err := os.Chmod(path, 0o700); err != nil {
				return err
			}
		} else if errors.Is(err, os.ErrNotExist) {
			if err := os.MkdirAll(path, 0o700); err != nil {
				return err
			}
			if err := os.Chmod(path, 0o700); err != nil {
				return err
			}
		} else {
			return err
		}
	}
	if err := os.Chmod(filepath.Join(dataRoot, "prepared-secrets"), 0o755); err != nil {
		return err
	}
	if err := os.Chmod(filepath.Join(dataRoot, "trust"), 0o755); err != nil {
		return err
	}
	return nil
}

func ensureBootstrapDirectories(dataRoot string) error {
	for _, path := range []string{dataRoot, filepath.Join(dataRoot, "control")} {
		if info, err := os.Lstat(path); err == nil {
			if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("%s is not a real directory", path)
			}
			if err := os.Chmod(path, 0o700); err != nil {
				return err
			}
		} else if errors.Is(err, os.ErrNotExist) {
			if err := os.MkdirAll(path, 0o700); err != nil {
				return err
			}
			if err := os.Chmod(path, 0o700); err != nil {
				return err
			}
		} else {
			return err
		}
	}
	return nil
}

func ensureSecret(path string, random io.Reader) error {
	if _, err := os.Lstat(path); err == nil {
		return validateSecret(path)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	value := make([]byte, 32)
	if _, err := io.ReadFull(random, value); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	remove := true
	defer func() {
		if remove {
			_ = os.Remove(path)
		}
	}()
	if _, err := fmt.Fprintf(file, "%s\n", hex.EncodeToString(value)); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	remove = false
	return nil
}

func validateSecret(path string) error {
	if err := inspectPrivateFile(path); err != nil {
		return err
	}
	value, err := readBoundedFile(path, 1_024)
	if err != nil {
		return err
	}
	trimmed := strings.TrimSpace(string(value))
	if len(trimmed) != 64 {
		return fmt.Errorf("existing secret %s has an invalid length", path)
	}
	if _, err := hex.DecodeString(trimmed); err != nil {
		return fmt.Errorf("existing secret %s is not hexadecimal", path)
	}
	return nil
}

func renderConfiguration(options InstallOptions, releaseVersion string, installation Installation) error {
	bindAddress := "0.0.0.0"
	if options.Mode == "local" {
		bindAddress = "127.0.0.1"
	}
	tlsProfilePath, err := caddyTLSProfilePath(options.ReleaseDir, options.TLSProfile)
	if err != nil {
		return err
	}
	deploymentTrustFile := ""
	deploymentTrustRotationFile := ""
	if options.TLSProfile == "private_scoped_ca" {
		deploymentTrustFile = "/run/agentroom/trust/deployment-trust.json"
		deploymentTrustRotationFile = "/run/agentroom/trust/deployment-trust-rotation.json"
		if err := ensurePrivateCaddyProfiles(installation); err != nil {
			return err
		}
		tlsProfilePath = installation.CaddyTLSProfilePath
	}
	environment := strings.Join([]string{
		"CONVENE_WIRE_DOMAIN=" + dotenvQuote(options.Domain),
		"CONVENE_WIRE_PUBLIC_ORIGIN=" + dotenvQuote(options.PublicOrigin),
		"CONVENE_WIRE_BIND_ADDRESS=" + bindAddress,
		"CONVENE_WIRE_HTTP_PORT=" + strconv.Itoa(options.HTTPPort),
		"CONVENE_WIRE_HTTPS_PORT=" + strconv.Itoa(options.HTTPSPort),
		"CONVENE_WIRE_IMAGE_TAG=" + dotenvQuote(strings.TrimPrefix(releaseVersion, "v")),
		"CONVENE_WIRE_DATABASE_PATH=/data/agent-room.sqlite",
		"CONVENE_WIRE_CADDY_TLS_PROFILE_FILE=" + dotenvQuote(tlsProfilePath),
		"CONVENE_WIRE_CADDY_PKI_PROFILE_FILE=" + dotenvQuote(caddyPKIProfilePath(options, installation)),
		"CONVENE_WIRE_DEPLOYMENT_TRUST_FILE=" + dotenvQuote(deploymentTrustFile),
		"CONVENE_WIRE_DEPLOYMENT_TRUST_ROTATION_FILE=" + dotenvQuote(deploymentTrustRotationFile),
		"CONVENE_WIRE_OWNER_RECOVERY_TOKEN_FILE=" + dotenvQuote(installation.OwnerSecretPath),
		"CONVENE_WIRE_LOG_MAX_SIZE=10m",
		"CONVENE_WIRE_LOG_MAX_FILES=5",
		"",
	}, "\n")
	if err := writeAtomic(installation.EnvironmentPath, []byte(environment), 0o600); err != nil {
		return err
	}
	quote := strconv.Quote
	override := fmt.Sprintf(`services:
  secret-init:
    volumes:
      - type: bind
        source: %s
        target: /source/owner_recovery_token
        read_only: true
      - type: bind
        source: %s
        target: /prepared
  data-init:
    volumes:
      - type: bind
        source: %s
        target: /data
      - type: bind
        source: %s
        target: /backups
  agentroom:
    volumes:
      - type: bind
        source: %s
        target: /data
      - type: bind
        source: %s
        target: /backups
      - type: bind
        source: %s
        target: /run/secrets
        read_only: true
      - type: bind
        source: %s
        target: /run/agentroom/trust
        read_only: true
  caddy:
    volumes:
      - type: bind
        source: %s
        target: /data
      - type: bind
        source: %s
        target: /config
      - type: bind
        source: %s
        target: /run/agentroom/trust
        read_only: true
`, quote(installation.OwnerSecretPath),
		quote(filepath.Join(options.DataRoot, "prepared-secrets")),
		quote(filepath.Join(options.DataRoot, "data")),
		quote(filepath.Join(options.DataRoot, "backups")),
		quote(filepath.Join(options.DataRoot, "data")),
		quote(filepath.Join(options.DataRoot, "backups")),
		quote(filepath.Join(options.DataRoot, "prepared-secrets")),
		quote(installation.TrustDirectory),
		quote(filepath.Join(options.DataRoot, "caddy", "data")),
		quote(filepath.Join(options.DataRoot, "caddy", "config")),
		quote(installation.TrustDirectory),
	)
	return writeAtomic(installation.OverridePath, []byte(override), 0o600)
}

func caddyTLSProfilePath(releaseDir, profile string) (string, error) {
	name := ""
	switch profile {
	case "public_ca":
		name = "public-ca.caddy"
	case "private_scoped_ca":
		name = "private-scoped-ca.caddy"
	case "manual_ca", "local":
		name = "internal-ca.caddy"
	case "":
		name = "legacy-auto.caddy"
	default:
		return "", fmt.Errorf("unsupported TLS profile %q", profile)
	}
	return filepath.Join(releaseDir, "deploy", "tls", name), nil
}

func caddyPKIProfilePath(options InstallOptions, installation Installation) string {
	if options.TLSProfile == "private_scoped_ca" {
		return installation.CaddyPKIProfilePath
	}
	return filepath.Join(options.ReleaseDir, "deploy", "tls", "pki-none.caddy")
}

func installationEnvironment(installation Installation) (map[string]string, error) {
	environment := map[string]string{}
	if installation.Manifest.LegacyServerToken {
		value, err := readBoundedFile(installation.ServerSecretPath, 1_024)
		if err != nil {
			return nil, actionError("SECRET_READ_FAILED", "could not read the configured legacy Server Token", "Check the secret file ownership and permissions; do not copy it into the environment file.", err)
		}
		token := strings.TrimSpace(string(value))
		environment["CONVENE_WIRE_BRIDGE_SERVER_TOKEN"] = token
		environment["AGENT_ROOM_BRIDGE_SERVER_TOKEN"] = token
	} else {
		environment["CONVENE_WIRE_BRIDGE_SERVER_TOKEN"] = ""
		environment["AGENT_ROOM_BRIDGE_SERVER_TOKEN"] = ""
	}
	return environment, nil
}

func dotenvQuote(value string) string {
	return strconv.Quote(value)
}

func saveManifest(path string, manifest Manifest) error {
	value, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	value = append(value, '\n')
	return writeAtomic(path, value, 0o600)
}

func loadManifest(path string) (Manifest, bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return Manifest{}, false, nil
	}
	if err != nil {
		return Manifest{}, false, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o077 != 0 {
		return Manifest{}, false, actionError("MANIFEST_INVALID", "installation manifest must be a permission-restricted regular file", "Restore the original 0600 manifest; do not replace it with guessed values.", nil)
	}
	value, err := readBoundedFile(path, 1<<20)
	if err != nil {
		return Manifest{}, false, err
	}
	var manifest Manifest
	if err := decodeStrictJSON(value, &manifest); err != nil {
		return Manifest{}, false, actionError("MANIFEST_INVALID", "installation manifest is malformed", "Restore the exact manifest from backup or use a different empty data root.", err)
	}
	if manifest.SchemaVersion != legacyManifestSchemaVersion && manifest.SchemaVersion != manifestSchemaVersion {
		return Manifest{}, false, actionError("MANIFEST_VERSION_UNSUPPORTED", "installation manifest schema is unsupported", "Use the convenewirectl version that owns this manifest before upgrading.", nil)
	}
	if err := validateManifest(manifest); err != nil {
		return Manifest{}, false, actionError("MANIFEST_INVALID", "installation manifest TLS identity is invalid", "Restore the exact manifest from backup; do not infer or replace trust identity fields.", err)
	}
	return manifest, true, nil
}

func validateManifest(manifest Manifest) error {
	if manifest.SchemaVersion == legacyManifestSchemaVersion {
		if manifest.TLSProfile != "" || manifest.InstallationID != "" || manifest.TrustEpoch != 0 || manifest.CACertificateSHA256 != "" || manifest.PrivateCAID != "" {
			return fmt.Errorf("legacy manifest contains version 2 trust fields")
		}
		return nil
	}
	if !installIDPattern.MatchString(manifest.InstallationID) {
		return fmt.Errorf("installationId is invalid")
	}
	if manifest.Mode == "local" {
		if manifest.TLSProfile != "local" || manifest.TrustEpoch != 0 || manifest.CACertificateSHA256 != "" || manifest.PrivateCAID != "" {
			return fmt.Errorf("local manifest has an invalid trust profile")
		}
		return nil
	}
	if manifest.Mode != "direct_https" {
		return fmt.Errorf("network mode is invalid")
	}
	switch manifest.TLSProfile {
	case "public_ca", "manual_ca":
		if manifest.TrustEpoch != 0 || manifest.CACertificateSHA256 != "" || manifest.PrivateCAID != "" {
			return fmt.Errorf("non-scoped profile contains scoped trust state")
		}
	case "private_scoped_ca":
		if manifest.TrustEpoch < 1 {
			return fmt.Errorf("private trust epoch must be positive")
		}
		if manifest.CACertificateSHA256 != "" && !hashPattern.MatchString(manifest.CACertificateSHA256) {
			return fmt.Errorf("private CA digest is invalid")
		}
		if manifest.PrivateCAID != "" && !privateCAIDPattern.MatchString(manifest.PrivateCAID) {
			return fmt.Errorf("private CA ID is invalid")
		}
	default:
		return fmt.Errorf("TLS profile is invalid")
	}
	return nil
}

func writeAtomic(path string, value []byte, mode fs.FileMode) error {
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".convenewirectl-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(mode); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(value); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return err
	}
	return os.Chmod(path, mode)
}

func verifyRelease(releaseDir, checksumsPath, expectedChecksumDigest string) (ReleaseMetadata, string, error) {
	info, err := os.Lstat(releaseDir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return ReleaseMetadata{}, "", actionError("RELEASE_NOT_FOUND", "release directory does not exist as a real directory", "Extract one published central release and pass its absolute directory; symbolic links are intentionally rejected.", err)
	}
	checksumInfo, err := os.Lstat(checksumsPath)
	if err != nil || !checksumInfo.Mode().IsRegular() || checksumInfo.Mode()&os.ModeSymlink != 0 {
		return ReleaseMetadata{}, "", actionError("CHECKSUMS_MISSING", "release SHA256SUMS is missing or not a regular file", "Use the checksum file shipped with the same release; never substitute a symbolic link.", err)
	}
	checksumBytes, err := readBoundedFile(checksumsPath, 16<<20)
	if err != nil {
		return ReleaseMetadata{}, "", actionError("CHECKSUMS_MISSING", "release SHA256SUMS is missing or unreadable", "Use the checksum file shipped with the same release; never generate a replacement after download.", err)
	}
	checksumDigest := sha256.Sum256(checksumBytes)
	actualChecksumDigest := hex.EncodeToString(checksumDigest[:])
	if !hashPattern.MatchString(expectedChecksumDigest) || actualChecksumDigest != strings.ToLower(expectedChecksumDigest) {
		return ReleaseMetadata{}, "", actionError("CHECKSUM_PIN_MISMATCH", "release SHA256SUMS does not match the published digest", "Remove the release directory and checksum file, then download the exact published assets again.", nil)
	}
	expected := make(map[string]string)
	scanner := bufio.NewScanner(strings.NewReader(string(checksumBytes)))
	for scanner.Scan() {
		line := scanner.Text()
		hash, name, found := strings.Cut(line, "  ")
		clean := filepath.Clean(name)
		if !found || !hashPattern.MatchString(hash) || name == "" || clean != name || filepath.IsAbs(name) || name == "." || strings.HasPrefix(name, ".."+string(filepath.Separator)) || strings.Contains(name, "\\") {
			return ReleaseMetadata{}, "", actionError("CHECKSUMS_INVALID", "release SHA256SUMS contains an unsafe entry", "Download the exact published checksum file again.", nil)
		}
		if _, duplicate := expected[name]; duplicate {
			return ReleaseMetadata{}, "", actionError("CHECKSUMS_INVALID", "release SHA256SUMS contains a duplicate entry", "Download the exact published checksum file again.", nil)
		}
		expected[name] = hash
	}
	if err := scanner.Err(); err != nil || len(expected) == 0 {
		return ReleaseMetadata{}, "", actionError("CHECKSUMS_INVALID", "release SHA256SUMS is empty or unreadable", "Download the exact published checksum file again.", err)
	}
	actual := make(map[string]struct{})
	err = filepath.WalkDir(releaseDir, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == checksumsPath {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("release contains symlink: %s", path)
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("release contains non-regular file: %s", path)
		}
		relative, err := filepath.Rel(releaseDir, path)
		if err != nil {
			return err
		}
		actual[relative] = struct{}{}
		expectedHash, listed := expected[relative]
		if !listed {
			return fmt.Errorf("release file is not checksummed: %s", relative)
		}
		digest, err := digestFile(path)
		if err != nil {
			return err
		}
		if digest != expectedHash {
			return fmt.Errorf("checksum mismatch: %s", relative)
		}
		return nil
	})
	if err != nil {
		return ReleaseMetadata{}, "", actionError("RELEASE_CHECKSUM_MISMATCH", "release content failed checksum verification", "Remove the extracted directory and download the release plus SHA256SUMS again; do not execute its Compose files.", err)
	}
	for name := range expected {
		if _, found := actual[name]; !found {
			return ReleaseMetadata{}, "", actionError("RELEASE_CHECKSUM_MISMATCH", "a checksummed release file is missing", "Download and extract the complete release again.", fmt.Errorf("missing %s", name))
		}
	}
	for _, required := range []string{
		"compose.yaml", "Dockerfile",
		"package.json", "package-lock.json", "deploy/Caddyfile",
		"deploy/tls/public-ca.caddy", "deploy/tls/private-scoped-ca.caddy",
		"deploy/tls/internal-ca.caddy", "deploy/tls/legacy-auto.caddy",
		"deploy/tls/pki-none.caddy",
		"scripts/compose-backup.sh", "scripts/compose-restore.sh",
	} {
		if _, found := actual[required]; !found {
			return ReleaseMetadata{}, "", actionError("RELEASE_INCOMPLETE", "central release omits a required owned path", "Use an ConveneWire central release archive, not a source fragment or Bridge-only archive.", fmt.Errorf("missing %s", required))
		}
	}
	metadataNames := []string{"convenewire-central-release.json", "agentroom-central-release.json"}
	metadataName := ""
	for _, candidate := range metadataNames {
		if _, found := actual[candidate]; !found {
			continue
		}
		if metadataName != "" {
			return ReleaseMetadata{}, "", actionError(
				"RELEASE_METADATA_INVALID",
				"central release contains ambiguous current and legacy metadata",
				"Use one exact published archive; do not combine files from releases before and after the product rename.",
				nil,
			)
		}
		metadataName = candidate
	}
	if metadataName == "" {
		return ReleaseMetadata{}, "", actionError(
			"RELEASE_INCOMPLETE",
			"central release omits its owned metadata",
			"Use a complete ConveneWire release or an intact pre-rename AgentRoom central archive.",
			nil,
		)
	}
	metadataBytes, err := readBoundedFile(filepath.Join(releaseDir, metadataName), 1<<20)
	if err != nil {
		return ReleaseMetadata{}, "", err
	}
	var metadata ReleaseMetadata
	if err := decodeStrictJSON(metadataBytes, &metadata); err != nil || metadata.SchemaVersion != releaseSchemaVersion ||
		!releasePattern.MatchString(metadata.ReleaseVersion) || metadata.DataSchemaVersion < 1 ||
		!commitPattern.MatchString(metadata.SourceCommit) || !supportedTarget(metadata.TargetOS, metadata.TargetArch) {
		return ReleaseMetadata{}, "", actionError("RELEASE_METADATA_INVALID", "central release metadata is invalid", "Use the metadata and checksums from one exact published release.", err)
	}
	return metadata, actualChecksumDigest, nil
}

func supportedTarget(targetOS, targetArch string) bool {
	return (targetOS == "linux" || targetOS == "darwin") &&
		(targetArch == "amd64" || targetArch == "arm64")
}

func matchInstall(existing Manifest, options InstallOptions, metadata ReleaseMetadata, digest string) error {
	if existing.ReleaseVersion != metadata.ReleaseVersion ||
		existing.ReleaseDir != options.ReleaseDir || existing.ReleaseDigest != digest ||
		existing.DataSchemaVersion != metadata.DataSchemaVersion || existing.DataRoot != options.DataRoot ||
		existing.Mode != options.Mode || existing.Domain != options.Domain ||
		existing.PublicOrigin != options.PublicOrigin || existing.HTTPPort != options.HTTPPort ||
		existing.HTTPSPort != options.HTTPSPort || existing.LegacyServerToken != options.LegacyServerToken ||
		existing.ProjectName != options.ProjectName {
		return actionError("INSTALL_CONFLICT", "install arguments differ from the existing installation manifest", "Retry with the original arguments. Use convenewirectl upgrade for a new release; do not edit the manifest or replace secrets.", nil)
	}
	if existing.SchemaVersion == manifestSchemaVersion && existing.TLSProfile != options.TLSProfile {
		return actionError("INSTALL_CONFLICT", "TLS profile differs from the existing installation manifest", "Retry without changing --tls-profile. Trust-mode migration is an explicit lifecycle operation, not install reentry.", nil)
	}
	return nil
}

func dataRootHasState(dataRoot string) bool {
	info, err := os.Lstat(dataRoot)
	if errors.Is(err, os.ErrNotExist) {
		return false
	}
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return true
	}
	entries, err := os.ReadDir(dataRoot)
	if err != nil || len(entries) == 0 {
		return err != nil
	}
	if len(entries) != 1 || entries[0].Name() != "control" || !entries[0].IsDir() || entries[0].Type()&os.ModeSymlink != 0 {
		return true
	}
	controlEntries, err := os.ReadDir(filepath.Join(dataRoot, "control"))
	return err != nil || len(controlEntries) > 0
}

func checkPorts(bindAddress string, ports ...int) error {
	listeners := make([]net.Listener, 0, len(ports))
	defer func() {
		for _, listener := range listeners {
			_ = listener.Close()
		}
	}()
	for _, port := range ports {
		listener, err := net.Listen("tcp", net.JoinHostPort(bindAddress, strconv.Itoa(port)))
		if err != nil {
			return fmt.Errorf("%s:%d: %w", bindAddress, port, err)
		}
		listeners = append(listeners, listener)
	}
	return nil
}

func freeSpace(path string) (uint64, error) {
	var statistics syscall.Statfs_t
	if err := syscall.Statfs(path, &statistics); err != nil {
		return 0, err
	}
	return statistics.Bavail * uint64(statistics.Bsize), nil
}

func checkReadiness(ctx context.Context, input ReadinessInput) error {
	roots, err := x509.SystemCertPool()
	if err != nil || roots == nil {
		roots = x509.NewCertPool()
	}
	if input.TLSProfile == "private_scoped_ca" {
		certificate, _, digest, readErr := loadSingleCACertificate(input.LocalCARoot, time.Now())
		if readErr != nil {
			return fmt.Errorf("private CA root is invalid: %w", readErr)
		}
		if input.ExpectedCADigest == "" || digest != input.ExpectedCADigest {
			return fmt.Errorf("private CA digest does not match the installation manifest")
		}
		roots.AddCert(certificate)
	} else if input.TLSProfile != "public_ca" {
		if value, readErr := os.ReadFile(input.LocalCARoot); readErr == nil {
			if !roots.AppendCertsFromPEM(value) {
				return fmt.Errorf("local CA root is invalid")
			}
		}
	}
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	transport := &http.Transport{
		TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12},
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			_, port, err := net.SplitHostPort(address)
			if err != nil {
				return nil, fmt.Errorf("readiness target address is invalid: %w", err)
			}
			// Controller readiness is a host-local ingress check. Dialing Caddy
			// through loopback avoids DNS, DHCP and router-hairpin dependence while
			// the request URL still enforces the recorded Host and TLS ServerName.
			return dialer.DialContext(ctx, network, net.JoinHostPort("127.0.0.1", port))
		},
	}
	client := &http.Client{Transport: transport, Timeout: 10 * time.Second}
	deadline := time.Now().Add(input.Timeout)
	var lastError error
	for time.Now().Before(deadline) {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, input.PublicOrigin+"/api/health/ready", nil)
		if err != nil {
			return err
		}
		response, err := client.Do(request)
		if err == nil {
			_ = response.Body.Close()
			if response.StatusCode == http.StatusOK {
				lastError = nil
				break
			}
			err = fmt.Errorf("readiness returned HTTP %d", response.StatusCode)
		}
		lastError = err
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
		}
	}
	if lastError != nil {
		return lastError
	}
	key := make([]byte, 16)
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, input.PublicOrigin+"/ws/bridge", nil)
	if err != nil {
		return err
	}
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Upgrade", "websocket")
	request.Header.Set("Sec-WebSocket-Version", "13")
	request.Header.Set("Sec-WebSocket-Key", base64.StdEncoding.EncodeToString(key))
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("WebSocket ingress probe failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized && response.StatusCode != http.StatusForbidden {
		return fmt.Errorf("WebSocket ingress returned HTTP %d instead of an authentication boundary", response.StatusCode)
	}
	return nil
}

func loadSingleCACertificate(path string, now time.Time) (*x509.Certificate, []byte, string, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, nil, "", err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return nil, nil, "", fmt.Errorf("CA path must be a regular non-symlink file")
	}
	value, err := readBoundedFile(path, 64<<10)
	if err != nil {
		return nil, nil, "", err
	}
	block, remainder := pem.Decode(value)
	if block == nil || block.Type != "CERTIFICATE" || len(block.Headers) != 0 || len(bytes.TrimSpace(remainder)) != 0 {
		return nil, nil, "", fmt.Errorf("expected exactly one unadorned PEM certificate")
	}
	certificate, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, nil, "", err
	}
	if !certificate.BasicConstraintsValid || !certificate.IsCA || certificate.KeyUsage&x509.KeyUsageCertSign == 0 {
		return nil, nil, "", fmt.Errorf("certificate is not a constrained signing CA")
	}
	if now.Before(certificate.NotBefore) || !now.Before(certificate.NotAfter) {
		return nil, nil, "", fmt.Errorf("CA certificate is outside its validity window")
	}
	digest := sha256.Sum256(certificate.Raw)
	return certificate, value, hex.EncodeToString(digest[:]), nil
}

func publishPrivateTrust(installation Installation, manifest Manifest, now time.Time) (string, error) {
	rootPath := privateCARootPath(manifest, activePrivateCAID(manifest))
	certificate, _, digest, err := loadSingleCACertificate(rootPath, now)
	if err != nil {
		return "", err
	}
	if manifest.CACertificateSHA256 != "" && manifest.CACertificateSHA256 != digest {
		return "", fmt.Errorf("active CA digest differs from the recorded digest")
	}
	descriptor := deploymentTrustDescriptor{
		SchemaVersion:       1,
		Mode:                "private_scoped_ca",
		Origin:              manifest.PublicOrigin,
		InstallationID:      manifest.InstallationID,
		TrustEpoch:          manifest.TrustEpoch,
		CACertificateSHA256: digest,
	}
	value, err := json.MarshalIndent(descriptor, "", "  ")
	if err != nil {
		return "", err
	}
	value = append(value, '\n')
	canonicalPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate.Raw})
	if err := writeAtomic(installation.TrustCAPEMPath, canonicalPEM, 0o644); err != nil {
		return "", err
	}
	if err := writeAtomic(installation.TrustDescriptorPath, value, 0o644); err != nil {
		return "", err
	}
	return digest, nil
}

func newInstallationID(random io.Reader) (string, error) {
	value := make([]byte, 18)
	if _, err := io.ReadFull(random, value); err != nil {
		return "", err
	}
	return "install_" + base64.RawURLEncoding.EncodeToString(value), nil
}

func redactedDigest(value string) string {
	if len(value) <= 12 {
		return value
	}
	return value[:12] + "..."
}

func publicCAHostname(value string) bool {
	if net.ParseIP(value) != nil || !strings.Contains(value, ".") {
		return false
	}
	lower := strings.ToLower(value)
	for _, suffix := range []string{".local", ".localhost", ".internal", ".lan", ".home", ".test", ".invalid", ".example"} {
		if strings.HasSuffix(lower, suffix) {
			return false
		}
	}
	return true
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	address := net.ParseIP(host)
	return address != nil && address.IsLoopback()
}

func validDomain(value string) bool {
	if address := net.ParseIP(value); address != nil {
		return !strings.Contains(value, ":")
	}
	if !domainPattern.MatchString(value) || len(value) > 253 {
		return false
	}
	for _, label := range strings.Split(value, ".") {
		if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
	}
	return true
}

func validProjectName(value string) bool {
	if len(value) < 1 || len(value) > 63 ||
		(value[0] < 'a' || value[0] > 'z') && (value[0] < '0' || value[0] > '9') {
		return false
	}
	for _, character := range value {
		if character < 'a' || character > 'z' {
			if character < '0' || character > '9' {
				if character != '-' && character != '_' {
					return false
				}
			}
		}
	}
	return true
}

func redactCommandOutput(value string, environment map[string]string) string {
	redacted := value
	for key, secret := range environment {
		upper := strings.ToUpper(key)
		if secret != "" && (strings.Contains(upper, "TOKEN") ||
			strings.Contains(upper, "SECRET") || strings.Contains(upper, "CREDENTIAL")) {
			redacted = strings.ReplaceAll(redacted, secret, "[REDACTED]")
		}
	}
	return redacted
}

func readBoundedFile(path string, maximum int64) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > maximum {
		return nil, fmt.Errorf("%s must be a regular file no larger than %d bytes", path, maximum)
	}
	return os.ReadFile(path)
}

func digestFile(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

func decodeStrictJSON(value []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(value))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return fmt.Errorf("JSON contains more than one value")
		}
		return err
	}
	return nil
}

func versionAtLeast(value string, requiredMajor, requiredMinor int) bool {
	value = strings.TrimPrefix(strings.TrimSpace(value), "v")
	parts := strings.Split(value, ".")
	if len(parts) < 2 {
		return false
	}
	major, majorErr := strconv.Atoi(parts[0])
	minorText := parts[1]
	if index := strings.IndexFunc(minorText, func(value rune) bool { return value < '0' || value > '9' }); index >= 0 {
		minorText = minorText[:index]
	}
	minor, minorErr := strconv.Atoi(minorText)
	return majorErr == nil && minorErr == nil && (major > requiredMajor || major == requiredMajor && minor >= requiredMinor)
}

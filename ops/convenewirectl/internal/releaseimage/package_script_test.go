package releaseimage

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"debug/elf"
	"debug/macho"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestPackageCentralReleaseRunsSchemaV2VerifierForHost(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skip("Central release packaging supports Darwin and Linux hosts")
	}
	if runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64" {
		t.Skip("Central release packaging supports amd64 and arm64 hosts")
	}
	for _, command := range []string{"bash", "git", "go", "tar"} {
		if _, err := exec.LookPath(command); err != nil {
			t.Skipf("%s is required for Central release packaging", command)
		}
	}

	workingDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	repositoryRoot := filepath.Clean(filepath.Join(workingDirectory, "..", "..", "..", ".."))
	sourceCommitBytes, err := exec.Command("git", "-C", repositoryRoot, "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatalf("resolve source commit: %v", err)
	}
	sourceCommit := strings.TrimSpace(string(sourceCommitBytes))

	targetOS := "linux"
	if runtime.GOOS == "linux" {
		targetOS = "darwin"
	}
	targetArch := runtime.GOARCH
	const releaseTag = "v0.0.0-host-tool-test"
	version := strings.TrimPrefix(releaseTag, "v")
	imageArchiveName := "convenewire-central-image_" + version + "_linux_" + targetArch + ".oci.tar"
	imageMetadataName := "convenewire-central-image_" + version + "_linux_" + targetArch + ".metadata.json"

	bundleDirectory := t.TempDir()
	serverArchive := filepath.Join(bundleDirectory, "raw-server.oci.tar")
	caddyArchive := filepath.Join(bundleDirectory, "raw-caddy.oci.tar")
	fixtureOptions := rawOCIFixtureOptions{
		platform:       "linux/" + targetArch,
		releaseVersion: releaseTag,
		sourceCommit:   sourceCommit,
	}
	fixtureOptions.repository = ServerRepository
	writeRawBuildKitOCI(t, serverArchive, fixtureOptions)
	fixtureOptions.repository = CaddyRepository
	writeRawBuildKitOCI(t, caddyArchive, fixtureOptions)
	_, err = Finalize(FinalizeOptions{
		Images: []RawImage{
			{Role: ServerRole, Repository: ServerRepository, Archive: serverArchive},
			{Role: CaddyRole, Repository: CaddyRepository, Archive: caddyArchive},
		},
		OutputArchive:      filepath.Join(bundleDirectory, imageArchiveName),
		OutputMetadata:     filepath.Join(bundleDirectory, imageMetadataName),
		EmbeddedArchive:    "image/" + imageArchiveName,
		ReleaseVersion:     releaseTag,
		SourceCommit:       sourceCommit,
		Platform:           "linux/" + targetArch,
		BuilderID:          testBuilderID,
		BuildInvocationURI: testBuilderID + "/attempts/host-tool-test",
	})
	if err != nil {
		t.Fatalf("finalize schema-v2 fixture: %v", err)
	}

	outputDirectory := t.TempDir()
	scriptPath := filepath.Join(repositoryRoot, "ops", "convenewirectl", "scripts", "package-central-release.sh")
	command := exec.Command("bash", scriptPath)
	command.Dir = repositoryRoot
	command.Env = append(os.Environ(),
		"CENTRAL_RELEASE_SCHEMA=2",
		"CENTRAL_IMAGE_BUNDLE_DIR="+bundleDirectory,
		"OUTPUT_DIR="+outputDirectory,
		"RELEASE_TAG="+releaseTag,
		"SOURCE_REF="+sourceCommit,
		"GOOS="+targetOS,
		"GOARCH="+targetArch,
	)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("cross-target schema-v2 package failed: %v\n%s", err, output)
	}

	packageName := "convenewire-central_" + version + "_" + targetOS + "_" + targetArch
	archivePath := filepath.Join(outputDirectory, packageName+".tar.gz")
	assertPackagedControllerTarget(t, archivePath, packageName+"/bin/convenewirectl", targetOS, targetArch)
}

func assertPackagedControllerTarget(t *testing.T, archivePath, controllerPath, targetOS, targetArch string) {
	t.Helper()
	archive, err := os.Open(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	compressed, err := gzip.NewReader(archive)
	if err != nil {
		t.Fatal(err)
	}
	defer compressed.Close()

	reader := tar.NewReader(compressed)
	var controller []byte
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if header.Name == controllerPath {
			controller, err = io.ReadAll(reader)
			if err != nil {
				t.Fatal(err)
			}
			break
		}
	}
	if len(controller) == 0 {
		t.Fatalf("packaged archive omitted %s", controllerPath)
	}

	switch targetOS {
	case "darwin":
		binary, err := macho.NewFile(bytes.NewReader(controller))
		if err != nil {
			t.Fatalf("packaged controller is not Mach-O: %v", err)
		}
		defer binary.Close()
		wantCPU := macho.CpuAmd64
		if targetArch == "arm64" {
			wantCPU = macho.CpuArm64
		}
		if binary.Cpu != wantCPU {
			t.Fatalf("packaged controller CPU = %s, want %s", binary.Cpu, wantCPU)
		}
	case "linux":
		binary, err := elf.NewFile(bytes.NewReader(controller))
		if err != nil {
			t.Fatalf("packaged controller is not ELF: %v", err)
		}
		defer binary.Close()
		wantMachine := elf.EM_X86_64
		if targetArch == "arm64" {
			wantMachine = elf.EM_AARCH64
		}
		if binary.Machine != wantMachine {
			t.Fatalf("packaged controller machine = %s, want %s", binary.Machine, wantMachine)
		}
	default:
		t.Fatalf("unsupported test target OS %q", targetOS)
	}
}

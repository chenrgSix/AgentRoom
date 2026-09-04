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

func TestPackageCentralReleaseBuildsHostNeutralControllerHelpers(t *testing.T) {
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

	const releaseTag = "v0.0.0-host-tool-test"
	version := strings.TrimPrefix(releaseTag, "v")

	outputDirectory := t.TempDir()
	scriptPath := filepath.Join(repositoryRoot, "ops", "convenewirectl", "scripts", "package-central-release.sh")
	command := exec.Command("bash", scriptPath)
	command.Dir = repositoryRoot
	command.Env = append(os.Environ(),
		"OUTPUT_DIR="+outputDirectory,
		"RELEASE_TAG="+releaseTag,
		"SOURCE_REF="+sourceCommit,
	)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("host-neutral source package failed: %v\n%s", err, output)
	}

	packageName := "convenewire-central_" + version + "_source"
	archivePath := filepath.Join(outputDirectory, packageName+".tar.gz")
	for _, target := range []struct {
		path   string
		goos   string
		goarch string
	}{
		{path: "linux_amd64", goos: "linux", goarch: "amd64"},
		{path: "linux_arm64", goos: "linux", goarch: "arm64"},
		{path: "darwin_arm64", goos: "darwin", goarch: "arm64"},
	} {
		assertPackagedControllerTarget(t, archivePath,
			packageName+"/bin/"+target.path+"/convenewirectl", target.goos, target.goarch)
	}
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

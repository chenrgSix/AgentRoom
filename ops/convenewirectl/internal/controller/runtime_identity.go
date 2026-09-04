package controller

import (
	"context"
	"fmt"
	"regexp"
	"strings"
)

var (
	containerIDPattern = regexp.MustCompile(`^[0-9a-f]{12,64}$`)
	imageIDPattern     = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
)

func (controller *Controller) verifyActiveRuntimeIdentity(
	ctx context.Context,
	installation Installation,
	environment map[string]string,
	requireRunning bool,
) error {
	manifest := installation.Manifest
	if manifest.SourceBuild {
		return controller.verifySourceBuildRuntimeIdentity(ctx, installation, environment, requireRunning)
	}
	if !hasPinnedRuntimeImages(manifest) {
		return nil
	}
	services := []struct {
		name      string
		reference string
	}{
		{name: "agentroom", reference: manifest.ServerImage},
		{name: "caddy", reference: manifest.CaddyImage},
	}
	containerIDs := make(map[string]string, len(services))
	for _, service := range services {
		containerOutput, err := controller.runCompose(
			ctx,
			installation,
			environment,
			"ps",
			"--quiet",
			service.name,
		)
		if err != nil {
			return fmt.Errorf("resolve active %s container: %w", service.name, err)
		}
		containerID := strings.TrimSpace(containerOutput)
		if containerID == "" {
			containerIDs[service.name] = ""
			continue
		}
		if !containerIDPattern.MatchString(containerID) {
			return fmt.Errorf("service %s does not have exactly one running container", service.name)
		}
		containerIDs[service.name] = containerID
	}
	serverRunning := containerIDs["agentroom"] != ""
	caddyRunning := containerIDs["caddy"] != ""
	if !serverRunning && !caddyRunning && !requireRunning {
		return nil
	}
	if !serverRunning || !caddyRunning {
		return fmt.Errorf("Server and Caddy are not both running")
	}

	for _, service := range services {
		containerID := containerIDs[service.name]
		activeImage, err := controller.dependencies.Runner.Run(ctx, Command{
			Name: "docker",
			Args: []string{
				"container", "inspect", "--format", "{{.Image}}", containerID,
			},
		})
		if err != nil {
			return fmt.Errorf("inspect active %s image: %w", service.name, err)
		}
		expectedImage, err := controller.dependencies.Runner.Run(ctx, Command{
			Name: "docker",
			Args: []string{
				"image", "inspect", "--format", "{{.Id}}", service.reference,
			},
		})
		if err != nil {
			return fmt.Errorf("inspect expected %s image: %w", service.name, err)
		}
		activeID := strings.TrimSpace(activeImage)
		expectedID := strings.TrimSpace(expectedImage)
		if !imageIDPattern.MatchString(activeID) ||
			!imageIDPattern.MatchString(expectedID) || activeID != expectedID {
			return fmt.Errorf(
				"service %s runs image %q instead of the recorded immutable image identity",
				service.name,
				activeID,
			)
		}
	}

	return controller.verifyServerBuildIdentity(ctx, containerIDs["agentroom"], manifest)
}

func (controller *Controller) verifySourceBuildRuntimeIdentity(
	ctx context.Context,
	installation Installation,
	environment map[string]string,
	requireRunning bool,
) error {
	containerIDs := make(map[string]string, 2)
	for _, service := range []string{"agentroom", "caddy"} {
		containerOutput, err := controller.runCompose(
			ctx,
			installation,
			environment,
			"ps",
			"--quiet",
			service,
		)
		if err != nil {
			return fmt.Errorf("resolve active %s container: %w", service, err)
		}
		containerID := strings.TrimSpace(containerOutput)
		if containerID != "" && !containerIDPattern.MatchString(containerID) {
			return fmt.Errorf("service %s does not have exactly one running container", service)
		}
		containerIDs[service] = containerID
	}
	serverRunning := containerIDs["agentroom"] != ""
	caddyRunning := containerIDs["caddy"] != ""
	if !serverRunning && !caddyRunning && !requireRunning {
		return nil
	}
	if !serverRunning || !caddyRunning {
		return fmt.Errorf("Server and Caddy are not both running")
	}
	return controller.verifyServerBuildIdentity(ctx, containerIDs["agentroom"], installation.Manifest)
}

func (controller *Controller) verifyServerBuildIdentity(
	ctx context.Context,
	containerID string,
	manifest Manifest,
) error {
	metrics, err := controller.dependencies.Runner.Run(ctx, Command{
		Name: "docker",
		Args: []string{
			"exec", containerID, "node", "-e",
			`fetch("http://127.0.0.1:3000/api/metrics").then(async response => {
  if (!response.ok) process.exit(2);
  process.stdout.write(await response.text());
}).catch(() => process.exit(2));`,
		},
	})
	if err != nil {
		return fmt.Errorf("read active Server build identity: %w", err)
	}
	expectedBuildInfo := fmt.Sprintf(
		`convenewire_build_info{release_version="%s",source_commit="%s"} 1`,
		manifest.ReleaseVersion,
		manifest.SourceCommit,
	)
	buildLines := make([]string, 0, 1)
	for _, line := range strings.Split(metrics, "\n") {
		if strings.HasPrefix(line, "convenewire_build_info{") {
			buildLines = append(buildLines, strings.TrimSpace(line))
		}
	}
	if len(buildLines) != 1 || buildLines[0] != expectedBuildInfo {
		return fmt.Errorf("active Server build identity does not match the installation manifest")
	}
	return nil
}

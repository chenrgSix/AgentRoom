package provisioning

import (
	"reflect"
	"time"

	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/identity"
	contracts "convenewire.dev/contracts/generated/go"
)

type ReplaceConfig func(string, config.Config) error

type Decision struct {
	Configuration config.Config
	Accepted      bool
	Changed       bool
	Reason        contracts.Reason
}

// Apply clones only a locally configured template. The request can select an
// existing Runtime but cannot supply commands, paths, environment, credentials,
// tools, or permissions.
func Apply(
	current config.Config,
	configPath string,
	replace ReplaceConfig,
	authorizer *Authorizer,
	request contracts.AgentProvisionRequestedPayload,
	now time.Time,
) Decision {
	if valid, reason := authorizer.Verify(
		current.AgentProvisioning,
		request.ManagementCode,
		now,
	); !valid {
		return Decision{Configuration: current, Reason: reason}
	}
	return ApplyAuthorized(current, configPath, replace, request)
}

func ApplyAuthorized(
	current config.Config,
	configPath string,
	replace ReplaceConfig,
	request contracts.AgentProvisionRequestedPayload,
) Decision {
	identities, err := identity.LoadOrCreate(current.DataDir, current.Agents)
	if err != nil {
		return Decision{Configuration: current, Reason: contracts.ConfigurationFailed}
	}
	templateIndex := -1
	requestedIndex := -1
	for index, configured := range current.Agents {
		agentID := identities[configured.Name]
		if agentID == request.TemplateAgentID {
			templateIndex = index
		}
		if agentID == request.AgentID {
			requestedIndex = index
		}
	}
	if templateIndex < 0 {
		return Decision{Configuration: current, Reason: contracts.TemplateNotFound}
	}
	template := current.Agents[templateIndex]
	if requestedIndex >= 0 {
		existing := current.Agents[requestedIndex]
		if existing.Name == request.Name && existing.Role == request.Role &&
			sameRuntimeConfiguration(existing, template) {
			return Decision{Configuration: current, Accepted: true}
		}
		return Decision{Configuration: current, Reason: contracts.IdentityConflict}
	}
	if existingID := identities[request.Name]; existingID != "" && existingID != request.AgentID {
		return Decision{Configuration: current, Reason: contracts.IdentityConflict}
	}
	candidate := cloneConfiguration(current)
	clone := cloneAgentConfiguration(template)
	clone.Name = request.Name
	clone.Role = request.Role
	candidate.Agents = append(candidate.Agents, clone)
	if err := candidate.Validate(); err != nil {
		return Decision{Configuration: current, Reason: contracts.InvalidRequest}
	}
	if err := identity.BindName(candidate.DataDir, clone.Name, request.AgentID); err != nil {
		return Decision{Configuration: current, Reason: contracts.IdentityConflict}
	}
	if err := replace(configPath, candidate); err != nil {
		return Decision{Configuration: current, Reason: contracts.ConfigurationFailed}
	}
	return Decision{Configuration: candidate, Accepted: true, Changed: true}
}

func cloneConfiguration(source config.Config) config.Config {
	clone := source
	clone.Agents = make([]config.AgentConfig, len(source.Agents))
	for index, agent := range source.Agents {
		clone.Agents[index] = cloneAgentConfiguration(agent)
	}
	return clone
}

func cloneAgentConfiguration(source config.AgentConfig) config.AgentConfig {
	clone := source
	clone.Command = append([]string{}, source.Command...)
	clone.EnvAllowlist = append([]string{}, source.EnvAllowlist...)
	return clone
}

func sameRuntimeConfiguration(left, right config.AgentConfig) bool {
	left = cloneAgentConfiguration(left)
	right = cloneAgentConfiguration(right)
	left.Name, left.Role = "", ""
	right.Name, right.Role = "", ""
	return reflect.DeepEqual(left, right)
}

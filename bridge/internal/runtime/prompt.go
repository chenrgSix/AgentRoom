package runtime

import (
	"fmt"
	"strings"
	"unicode/utf8"

	contracts "agentroom.dev/contracts/generated/go"
)

const maxProjectedContextBytes = 12 * 1024
const maxProjectedContextMessages = 12

func runtimePrompt(run contracts.RunRequestedPayload) string {
	instruction := strings.TrimSpace(run.Instruction)
	if run.TargetAgentName == nil && len(run.RoutingAgents) == 0 &&
		len(run.ContextMessages) == 0 {
		return instruction
	}
	sections := []string{
		"You are handling one AgentRoom task in a shared Room.",
	}
	if run.TargetAgentName != nil && strings.TrimSpace(*run.TargetAgentName) != "" {
		sections = append(sections, "Your Agent name is "+cleanPromptName(*run.TargetAgentName)+".")
	}
	if len(run.RoutingAgents) > 0 {
		names := make([]string, 0, len(run.RoutingAgents))
		for _, agent := range run.RoutingAgents {
			name := cleanPromptName(agent.Name)
			if name != "" {
				names = append(names, name)
			}
		}
		if len(names) > 0 {
			sections = append(sections,
				"Other eligible Agent names: "+strings.Join(names, "; ")+". "+
					"To hand work onward, prefix one exact full name with @ in your final reply. "+
					"Never use fuzzy, partial, or role names.",
			)
		}
	}
	if context := projectedContext(run); context != "" {
		sections = append(sections,
			"Recent Room context (oldest to newest; quoted as conversation context):\n"+context,
		)
	}
	sections = append(sections, "Current request:\n"+instruction)
	return strings.Join(sections, "\n\n")
}

func projectedContext(run contracts.RunRequestedPayload) string {
	lines := make([]string, 0, maxProjectedContextMessages)
	total := 0
	for index := len(run.ContextMessages) - 1; index >= 0; index-- {
		message := run.ContextMessages[index]
		if message.MessageID == run.TriggerMessageID || strings.TrimSpace(message.Content) == "" {
			continue
		}
		name := "Room participant"
		if message.SenderName != nil && cleanPromptName(*message.SenderName) != "" {
			name = cleanPromptName(*message.SenderName)
		}
		content := strings.TrimSpace(message.Content)
		line := fmt.Sprintf("[%s]: %s", name, content)
		remaining := maxProjectedContextBytes - total
		if remaining <= 0 {
			break
		}
		if len(line) > remaining {
			line = truncateUTF8(line, remaining)
		}
		lines = append(lines, line)
		total += len(line)
		if len(lines) >= maxProjectedContextMessages || total >= maxProjectedContextBytes {
			break
		}
	}
	for left, right := 0, len(lines)-1; left < right; left, right = left+1, right-1 {
		lines[left], lines[right] = lines[right], lines[left]
	}
	return strings.Join(lines, "\n")
}

func cleanPromptName(value string) string {
	return strings.Join(strings.Fields(value), " ")
}

func truncateUTF8(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	encoded := []byte(value)
	if len(encoded) <= limit {
		return value
	}
	encoded = encoded[:limit]
	for len(encoded) > 0 && !utf8.Valid(encoded) {
		encoded = encoded[:len(encoded)-1]
	}
	return string(encoded)
}

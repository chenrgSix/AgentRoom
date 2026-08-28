package runtime

import (
	"bytes"
	"encoding/json"
	"io"
	"strings"

	contracts "convenewire.dev/contracts/generated/go"
)

const (
	clarificationOpen  = "<agentroom-clarification>"
	clarificationClose = "</agentroom-clarification>"
)

func parseTaskClarificationEnvelope(
	source string,
) (string, *contracts.TaskClarificationRequest) {
	trimmed := strings.TrimSpace(source)
	if !strings.HasSuffix(trimmed, clarificationClose) {
		return trimmed, nil
	}
	start := strings.LastIndex(trimmed, clarificationOpen)
	if start < 0 {
		return trimmed, nil
	}
	jsonStart := start + len(clarificationOpen)
	jsonEnd := len(trimmed) - len(clarificationClose)
	decoder := json.NewDecoder(bytes.NewBufferString(trimmed[jsonStart:jsonEnd]))
	decoder.DisallowUnknownFields()
	var clarification contracts.TaskClarificationRequest
	if err := decoder.Decode(&clarification); err != nil ||
		clarification.Kind != contracts.Task {
		return trimmed, nil
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return trimmed, nil
	}
	clarification.Question = strings.TrimSpace(clarification.Question)
	if clarification.Question == "" || len([]rune(clarification.Question)) > 2_000 ||
		(len(clarification.Choices) > 0 && len(clarification.Choices) < 2) ||
		len(clarification.Choices) > 8 {
		return trimmed, nil
	}
	seen := make(map[string]struct{}, len(clarification.Choices))
	for index, choice := range clarification.Choices {
		choice = strings.TrimSpace(choice)
		if choice == "" || len([]rune(choice)) > 240 {
			return trimmed, nil
		}
		if _, duplicate := seen[choice]; duplicate {
			return trimmed, nil
		}
		seen[choice] = struct{}{}
		clarification.Choices[index] = choice
	}
	return strings.TrimSpace(trimmed[:start]), &clarification
}

func stripPrivateEnvelopePreview(value string) string {
	boundary := len(value)
	for _, marker := range []string{assessmentOpen, clarificationOpen} {
		if index := strings.Index(value, marker); index >= 0 && index < boundary {
			boundary = index
		}
	}
	return strings.TrimSpace(value[:boundary])
}

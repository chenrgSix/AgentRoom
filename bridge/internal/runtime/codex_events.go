package runtime

import (
	"encoding/json"
	"fmt"
	"strings"
)

type CodexEventParser struct {
	ThreadID string
	Reply    string
	Complete bool
	Failure  string
}

func (p *CodexEventParser) Consume(line []byte) error {
	var envelope struct {
		Type     string `json:"type"`
		ThreadID string `json:"thread_id"`
		Message  string `json:"message"`
		Error    *struct {
			Message string `json:"message"`
		} `json:"error"`
		Item *struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"item"`
	}
	if err := json.Unmarshal(line, &envelope); err != nil {
		return fmt.Errorf("decode Codex JSONL event: %w", err)
	}
	if envelope.Type == "" {
		return fmt.Errorf("Codex JSONL event is missing type")
	}
	switch envelope.Type {
	case "thread.started":
		if envelope.ThreadID == "" {
			return fmt.Errorf("Codex thread.started event is missing thread_id")
		}
		p.ThreadID = envelope.ThreadID
	case "item.completed":
		if envelope.Item != nil && envelope.Item.Type == "agent_message" {
			text := strings.TrimSpace(envelope.Item.Text)
			if text != "" {
				p.Reply = text
			}
		}
	case "turn.completed":
		p.Complete = true
	case "turn.failed", "error":
		p.Failure = strings.TrimSpace(envelope.Message)
		if envelope.Error != nil && strings.TrimSpace(envelope.Error.Message) != "" {
			p.Failure = strings.TrimSpace(envelope.Error.Message)
		}
		if p.Failure == "" {
			p.Failure = "Codex reported an unsuccessful turn."
		}
	}
	return nil
}

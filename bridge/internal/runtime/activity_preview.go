package runtime

import "strings"

const activityEventRunes = 1_000
const activityPreviewMinimumRunes = 48

// activityTextPreview keeps a small unpublished tail so a secret split across
// Runtime events is redacted before any part of it crosses the Bridge boundary.
// The whole accumulated summary is re-redacted on every projection because a
// later fragment can change how the end of the previous fragment is classified.
type activityTextPreview struct {
	current      strings.Builder
	emitted      string
	resetPending bool
	artifacts    []VerifiedArtifactAlias
}

func (p *activityTextPreview) append(content string, reset bool) {
	if reset {
		p.current.Reset()
		p.resetPending = p.emitted != ""
	}
	p.current.WriteString(content)
}

func (p *activityTextPreview) project(id, label string, force bool) []Activity {
	visible := RedactRuntimeText(p.current.String(), p.artifacts)
	if !force {
		runes := []rune(visible)
		safetyRunes := artifactPreviewSafetyRunes(p.artifacts)
		if len(runes) <= safetyRunes {
			visible = ""
		} else {
			visible = string(runes[:len(runes)-safetyRunes])
		}
	}
	if visible == p.emitted || visible == "" {
		return nil
	}

	reset := p.resetPending || !strings.HasPrefix(visible, p.emitted)
	if !force && !reset &&
		len([]rune(strings.TrimPrefix(visible, p.emitted))) < activityPreviewMinimumRunes {
		return nil
	}
	content := visible
	if !reset {
		content = strings.TrimPrefix(visible, p.emitted)
	}
	if content == "" {
		return nil
	}

	runes := []rune(content)
	activities := make([]Activity, 0, (len(runes)/activityEventRunes)+1)
	first := true
	for len(runes) > 0 {
		length := len(runes)
		if length > activityEventRunes {
			length = activityEventRunes
		}
		activities = append(activities, Activity{
			ID: id, Kind: "reasoning", Phase: "updated", Label: label,
			Content: string(runes[:length]), Reset: reset && first,
		})
		first = false
		runes = runes[length:]
	}
	p.emitted = visible
	p.resetPending = false
	return activities
}

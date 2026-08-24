package runtime

import (
	"strings"
	"testing"
)

func TestActivityTextPreviewWithholdsAndRedactsSplitSecrets(t *testing.T) {
	preview := &activityTextPreview{}
	preview.append(strings.Repeat("context ", 10)+"token=split", false)
	first := preview.project("reasoning-1", "Thinking", false)
	preview.append("-secret-value-123456", false)
	second := preview.project("reasoning-1", "Thinking", false)
	final := preview.project("reasoning-1", "Thinking", true)

	var visible strings.Builder
	for _, batch := range [][]Activity{first, second, final} {
		for _, activity := range batch {
			if activity.Reset {
				visible.Reset()
			}
			visible.WriteString(activity.Content)
		}
	}
	if strings.Contains(visible.String(), "split-secret") {
		t.Fatalf("split secret crossed activity boundary: %q", visible.String())
	}
	if !strings.Contains(visible.String(), "[REDACTED]") {
		t.Fatalf("redaction marker missing: %q", visible.String())
	}
}

func TestActivityTextPreviewProjectsReset(t *testing.T) {
	preview := &activityTextPreview{}
	preview.append(strings.Repeat("old ", 30), false)
	_ = preview.project("reasoning-1", "Thinking", false)
	preview.append("replacement summary", true)
	activities := preview.project("reasoning-1", "Thinking", true)
	if len(activities) != 1 || !activities[0].Reset || activities[0].Content != "replacement summary" {
		t.Fatalf("unexpected reset projection: %#v", activities)
	}
}

func TestActivityTextPreviewCoalescesSmallRuntimeFragments(t *testing.T) {
	preview := &activityTextPreview{}
	preview.append(strings.Repeat("context ", 10), false)
	if activities := preview.project("reasoning-1", "Thinking", false); len(activities) != 0 {
		t.Fatalf("small unpublished fragment was not coalesced: %#v", activities)
	}
	preview.append(strings.Repeat("detail ", 10), false)
	if activities := preview.project("reasoning-1", "Thinking", false); len(activities) != 1 {
		t.Fatalf("coalesced fragment was not projected: %#v", activities)
	}
}

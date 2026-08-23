package runtime

import "testing"

func TestAssessmentEnvelopeSeparatesVisibleReply(t *testing.T) {
	reply, assessment := parseAssessmentEnvelope(`Use a first-terminal-wins fence.
<agentroom-assessment>{"goalSatisfied":true,"confidence":0.91,"recommendation":"finish"}</agentroom-assessment>`)
	if reply != "Use a first-terminal-wins fence." || assessment == nil ||
		assessment.GoalSatisfied == nil || !*assessment.GoalSatisfied {
		t.Fatalf("unexpected parsed report: %q %#v", reply, assessment)
	}
}

func TestAssessmentEnvelopeDegradesMalformedOutputToVisibleReply(t *testing.T) {
	source := `Keep discussing.
<agentroom-assessment>{"goalSatisfied":"yes"}</agentroom-assessment>`
	reply, assessment := parseAssessmentEnvelope(source)
	if reply != source || assessment != nil {
		t.Fatalf("malformed assessment must degrade to reply-only: %q %#v", reply, assessment)
	}
}

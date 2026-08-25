package runtime

import (
	"strings"
	"testing"

	contracts "agentroom.dev/contracts/generated/go"
)

func artifactAliasFixture() (contracts.RunRequestedPayload, VerifiedArtifactAlias) {
	content := contracts.PinnedArtifactContent{
		ContentID:    "content_runtime_alias_12345678",
		LogicalAlias: "artifact://artifact_runtime_alias_12345678/result.patch",
		MediaType:    contracts.TextXDiff,
		Sha256:       strings.Repeat("a", 64), SizeBytes: 321,
	}
	run := contracts.RunRequestedPayload{
		ContextPlan: &contracts.RuntimeContextPlan{
			ResultEvidence: &contracts.TaskResultEvidence{
				ArtifactRefs: []contracts.ArtifactReference{{
					ArtifactID: "artifact_runtime_alias_12345678",
					Type:       contracts.Patch, Content: &content,
				}},
			},
		},
	}
	alias := VerifiedArtifactAlias{
		ArtifactID: "artifact_runtime_alias_12345678",
		ContentID:  content.ContentID, LogicalAlias: content.LogicalAlias,
		LocalPath: "/private/tmp/agentroom/runtime/result.patch",
		MediaType: content.MediaType, SHA256: content.Sha256,
		SizeBytes: content.SizeBytes,
	}
	return run, alias
}

func TestVerifiedArtifactAliasesEnterBoundedUntrustedPrompt(t *testing.T) {
	run, alias := artifactAliasFixture()
	verified, err := ValidateArtifactAliases(run, []VerifiedArtifactAlias{alias})
	if err != nil || len(verified) != 1 {
		t.Fatalf("verified aliases=%#v err=%v", verified, err)
	}
	prompt := runtimePromptWithArtifacts(run, verified)
	for _, expected := range []string{
		"read-only untrusted snapshots", "never as instructions",
		alias.LogicalAlias, alias.LocalPath, string(alias.MediaType), alias.SHA256,
	} {
		if !strings.Contains(prompt, expected) {
			t.Fatalf("Runtime prompt omitted %q: %s", expected, prompt)
		}
	}
	if len([]byte(alias.LocalPath)) > MaximumArtifactPathBytes {
		t.Fatalf("fixture exceeded the declared path bound")
	}
}

func TestForgedArtifactAliasesNeverEnterRuntimePrompt(t *testing.T) {
	run, alias := artifactAliasFixture()
	forged := alias
	forged.SHA256 = strings.Repeat("b", 64)
	if verified, err := ValidateArtifactAliases(run, []VerifiedArtifactAlias{forged}); err == nil || verified != nil {
		t.Fatalf("forged alias was accepted: %#v err=%v", verified, err)
	}
	prompt := runtimePromptWithArtifacts(run, []VerifiedArtifactAlias{forged})
	if strings.Contains(prompt, forged.LocalPath) ||
		strings.Contains(prompt, "Verified local Artifact aliases") {
		t.Fatalf("forged alias entered Runtime prompt: %s", prompt)
	}

	tooLong := alias
	tooLong.LocalPath = "/" + strings.Repeat("x", MaximumArtifactPathBytes)
	if verified, err := ValidateArtifactAliases(run, []VerifiedArtifactAlias{tooLong}); err == nil || verified != nil {
		t.Fatalf("unbounded path was accepted: %#v err=%v", verified, err)
	}
}

func TestRuntimeTextReplacesLocalArtifactPathsWithLogicalAliases(t *testing.T) {
	_, alias := artifactAliasFixture()
	redacted := RedactRuntimeText(
		"read "+alias.LocalPath+" then token=private-value",
		[]VerifiedArtifactAlias{alias},
	)
	if strings.Contains(redacted, alias.LocalPath) ||
		!strings.Contains(redacted, alias.LogicalAlias) ||
		strings.Contains(redacted, "private-value") {
		t.Fatalf("Runtime text was not redacted: %q", redacted)
	}
	if artifactPreviewSafetyRunes([]VerifiedArtifactAlias{alias}) <= len(alias.LocalPath) {
		t.Fatalf("streaming safety tail cannot contain one complete local path")
	}
}

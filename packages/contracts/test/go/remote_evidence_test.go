package contracts_test

import (
	"strings"
	"testing"

	runtimecontracts "convenewire.dev/contracts/generated/go/runtime"
)

func sealRemote(t *testing.T, value map[string]any, digestField string, excluded ...string) {
	t.Helper()
	value[digestField] = executionDigest(t, withoutFields(value, excluded...))
}

func TestRemoteEvidenceGoValidation(t *testing.T) {
	at := "2026-09-02T12:00:00.000Z"
	binding := map[string]any{
		"version": 1, "providerBindingId": "provider_example001",
		"teamId": "team_example001", "repositoryId": "repo_example001",
		"providerOrigin": "http://127.0.0.1:4317", "providerRepositoryId": "owner/repository",
		"ciChecks": []any{map[string]any{
			"checkKey": "unit", "profileId": "profile_example001",
			"profileRevision": 1, "profileDigest": strings.Repeat("a", 64),
		}},
		"createdByMemberId": "member_example001", "bindingDigest": strings.Repeat("0", 64),
		"createdAt": at,
	}
	sealRemote(t, binding, "bindingDigest", "bindingDigest", "createdAt")
	if err := runtimecontracts.ValidateExecutionCommand("remoteProviderBinding", encodeJSON(t, binding)); err != nil {
		t.Fatalf("valid remote binding rejected: %v", err)
	}
	badOrigin := decodeMap(t, encodeJSON(t, binding))
	badOrigin["providerOrigin"] = "http://provider.example"
	sealRemote(t, badOrigin, "bindingDigest", "bindingDigest", "createdAt")
	if runtimecontracts.ValidateExecutionCommand("remoteProviderBinding", encodeJSON(t, badOrigin)) == nil {
		t.Fatal("public cleartext provider origin accepted")
	}

	providerCommit := map[string]any{
		"version": 1, "operationId": "op_remote_commit0001",
		"observationId": "observation_commit0001", "providerRepositoryId": "owner/repository",
		"objectFormat": "sha1", "baseCommit": strings.Repeat("1", 40),
		"commit": strings.Repeat("2", 40), "tree": strings.Repeat("3", 40),
		"bundleDigest": strings.Repeat("b", 64), "bundleByteLength": 100,
		"pullRequest": nil, "providerObservationDigest": strings.Repeat("0", 64), "observedAt": at,
	}
	sealRemote(t, providerCommit, "providerObservationDigest", "providerObservationDigest")
	if err := runtimecontracts.ValidateExecutionCommand("providerCommitObservation", encodeJSON(t, providerCommit)); err != nil {
		t.Fatalf("valid provider commit rejected: %v", err)
	}
	wrongFormat := decodeMap(t, encodeJSON(t, providerCommit))
	wrongFormat["tree"] = strings.Repeat("3", 64)
	sealRemote(t, wrongFormat, "providerObservationDigest", "providerObservationDigest")
	if runtimecontracts.ValidateExecutionCommand("providerCommitObservation", encodeJSON(t, wrongFormat)) == nil {
		t.Fatal("wrong Git object format accepted")
	}

	providerCI := map[string]any{
		"version": 1, "operationId": "op_remote_ci0000001",
		"observationId": "observation_ci00000001", "providerRepositoryId": "owner/repository",
		"checkKey": "unit", "attempt": 1, "commit": strings.Repeat("2", 40),
		"tree": strings.Repeat("3", 40), "outcome": "passed",
		"providerObservationDigest": strings.Repeat("0", 64), "observedAt": at,
	}
	sealRemote(t, providerCI, "providerObservationDigest", "providerObservationDigest")
	if err := runtimecontracts.ValidateExecutionCommand("providerCIObservation", encodeJSON(t, providerCI)); err != nil {
		t.Fatalf("valid provider CI observation rejected: %v", err)
	}
	receipt := decodeMap(t, encodeJSON(t, providerCI))
	receipt["providerBindingId"] = "provider_example001"
	receipt["repositoryId"] = "repo_example001"
	receipt["sourceEvidenceId"] = "source_example0001"
	receipt["profileId"] = "profile_example001"
	receipt["profileRevision"] = 1
	receipt["profileDigest"] = strings.Repeat("a", 64)
	receipt["receiptDigest"] = strings.Repeat("0", 64)
	sealRemote(t, receipt, "receiptDigest", "receiptDigest")
	if err := runtimecontracts.ValidateExecutionCommand("remoteCIObservationReceipt", encodeJSON(t, receipt)); err != nil {
		t.Fatalf("valid remote CI receipt rejected: %v", err)
	}
	receipt["checkKey"] = "foreign"
	if runtimecontracts.ValidateExecutionCommand("remoteCIObservationReceipt", encodeJSON(t, receipt)) == nil {
		t.Fatal("tampered remote CI receipt accepted")
	}
}

func TestProofControlCommandsHaveClosedGoValidation(t *testing.T) {
	digest := strings.Repeat("a", 64)
	remote := map[string]any{
		"operationId": "op_web_adopt00001", "providerBindingId": "provider_web00001",
		"planRevision": 1, "nodeKey": "Build", "expectedPlanDigest": digest,
		"expectedControlRevision": 2, "sourceEvidenceId": "source_web_remote01",
	}
	if err := runtimecontracts.ValidateExecutionCommand("remoteEvidenceAdoptionCommand", encodeJSON(t, remote)); err != nil {
		t.Fatalf("valid remote adoption command rejected: %v", err)
	}
	remote["credential"] = "forbidden"
	if runtimecontracts.ValidateExecutionCommand("remoteEvidenceAdoptionCommand", encodeJSON(t, remote)) == nil {
		t.Fatal("remote adoption command accepted an undeclared credential")
	}

	integration := map[string]any{
		"operationId": "op_web_integrate001", "candidateCommit": strings.Repeat("2", 40),
		"candidateTree": strings.Repeat("3", 40), "deadline": "2026-09-03T01:05:00.000Z",
		"inputDigest": digest, "materializationDigest": strings.Repeat("b", 64),
		"nodeKey": "Build", "planId": "plan_web0000001", "planRevision": 1,
		"target": map[string]any{
			"repositoryId": "repo_web00001", "targetRef": "refs/heads/main",
			"expectedCommit": strings.Repeat("1", 40),
		},
		"verificationReceipts": []any{map[string]any{
			"receiptDigest": strings.Repeat("c", 64),
			"verificationId": "verification_web00001",
		}},
	}
	if err := runtimecontracts.ValidateExecutionCommand("integrationApprovalCommand", encodeJSON(t, integration)); err != nil {
		t.Fatalf("valid integration approval command rejected: %v", err)
	}
}

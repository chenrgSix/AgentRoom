package contracts_test

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	execution "convenewire.dev/contracts/generated/go/execution"
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

func TestRemoteInputAttestationGoValidation(t *testing.T) {
	at := "2026-09-03T01:00:00.000Z"
	input := map[string]any{
		"adoptionId": "adoption_inputsource0001", "adoptionDigest": strings.Repeat("a", 64),
		"reuseInput": map[string]any{
			"inputSlot": "source",
			"producer": map[string]any{
				"kind": "adopted_evidence",
				"edge": map[string]any{
					"edgeKey": "PrepareBuild", "fromNodeKey": "Prepare", "toNodeKey": "Build",
					"gate": "verified_output", "bindings": []any{map[string]any{
						"outputSlot": "patch", "inputSlot": "source",
					}},
				},
				"sourceEvidenceId": "source_inputsource0001",
				"sourceDigest":     strings.Repeat("b", 64),
				"proofSetDigest":   strings.Repeat("c", 64),
			},
			"artifact": map[string]any{
				"contentDigest": strings.Repeat("d", 64), "kind": "patch",
			},
		},
	}
	provider := map[string]any{
		"version": 1, "operationId": "op_remote_inputs00001",
		"attestationId":        "attestation_remoteinputs0001",
		"providerRepositoryId": "owner/repository", "nodeKey": "Build",
		"commit": strings.Repeat("2", 40), "tree": strings.Repeat("3", 40),
		"inputs": []any{input}, "remoteInputEvidenceDigest": strings.Repeat("0", 64),
		"providerAttestationDigest": strings.Repeat("0", 64), "attestedAt": at,
	}
	provider["remoteInputEvidenceDigest"] = executionDigest(t, []any{input["reuseInput"]})
	sealRemote(t, provider, "providerAttestationDigest", "providerAttestationDigest")
	if err := runtimecontracts.ValidateExecutionCommand("providerInputAttestation", encodeJSON(t, provider)); err != nil {
		t.Fatalf("valid provider input attestation rejected: %v", err)
	}
	providerJSON := encodeJSON(t, provider)
	var typedProvider execution.ProviderInputAttestation
	if err := json.Unmarshal(providerJSON, &typedProvider); err != nil {
		t.Fatalf("generated provider type rejected valid JSON: %v", err)
	}
	typedProviderJSON, err := json.Marshal(typedProvider)
	if err != nil || !reflect.DeepEqual(decodeJSON(t, providerJSON), decodeJSON(t, typedProviderJSON)) {
		t.Fatal("generated provider type changed attestation JSON")
	}
	retained := decodeMap(t, encodeJSON(t, provider))
	retained["providerBindingId"] = "provider_example001"
	retained["repositoryId"] = "repo_example001"
	retained["planId"] = "plan_example001"
	retained["planRevision"] = 1
	retained["sourceEvidenceId"] = "source_remoteoutput0001"
	retained["sourceDigest"] = strings.Repeat("e", 64)
	retained["sourceObservationId"] = "observation_commit0001"
	retained["sourceObservationDigest"] = strings.Repeat("f", 64)
	retained["attestationDigest"] = strings.Repeat("0", 64)
	sealRemote(t, retained, "attestationDigest", "attestationDigest")
	if err := runtimecontracts.ValidateExecutionCommand("remoteInputAttestation", encodeJSON(t, retained)); err != nil {
		t.Fatalf("valid retained input attestation rejected: %v", err)
	}
	retainedJSON := encodeJSON(t, retained)
	var typedRetained execution.RemoteInputAttestation
	if err := json.Unmarshal(retainedJSON, &typedRetained); err != nil {
		t.Fatalf("generated retained type rejected valid JSON: %v", err)
	}
	typedRetainedJSON, err := json.Marshal(typedRetained)
	if err != nil || !reflect.DeepEqual(decodeJSON(t, retainedJSON), decodeJSON(t, typedRetainedJSON)) {
		t.Fatal("generated retained type changed attestation JSON")
	}
	tampered := decodeMap(t, encodeJSON(t, retained))
	tamperedInputs := tampered["inputs"].([]any)
	tamperedReuse := tamperedInputs[0].(map[string]any)["reuseInput"].(map[string]any)
	tamperedReuse["artifact"].(map[string]any)["contentDigest"] = strings.Repeat("9", 64)
	sealRemote(t, tampered, "attestationDigest", "attestationDigest")
	if runtimecontracts.ValidateExecutionCommand("remoteInputAttestation", encodeJSON(t, tampered)) == nil {
		t.Fatal("tampered logical input accepted")
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
			"receiptDigest":  strings.Repeat("c", 64),
			"verificationId": "verification_web00001",
		}},
	}
	if err := runtimecontracts.ValidateExecutionCommand("integrationApprovalCommand", encodeJSON(t, integration)); err != nil {
		t.Fatalf("valid integration approval command rejected: %v", err)
	}
}

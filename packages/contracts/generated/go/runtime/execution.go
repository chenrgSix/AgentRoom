// Code generated from JSON Schema and the execution runtime template; DO NOT EDIT.

package runtimecontracts

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"net/url"
	"slices"
	"sort"
	"strconv"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

//go:embed execution-schema.json
var executionSchemaSource []byte

var ErrInvalidExecutionJSON = errors.New("execution JSON does not match the canonical wire contract")
var executionSchemas = compileExecutionSchemas()

func compileExecutionSchemas() map[string]*jsonschema.Schema {
	value, err := decodeSingleJSONValue(executionSchemaSource)
	if err != nil {
		panic("invalid generated execution schema")
	}
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	const id = "https://agentroom.dev/schemas/runtime/go-execution.json"
	if err := compiler.AddResource(id, value); err != nil {
		panic(err)
	}
	result := map[string]*jsonschema.Schema{}
	for _, kind := range []string{"executionManifest", "executionInputBinding", "executionCapability", "repositoryBinding",
		"runtimeAuthorityRequest", "runtimeAuthorityView", "executionGrant", "repositoryOperation", "repositoryReceipt",
		"executionCheckpoint", "verificationReceipt", "sourceEvidence", "gateProofRef", "evidenceAdoption",
		"schedulerControl", "schedulerModeCommand", "schedulerModeReceipt",
		"schedulerManualDispatchCommand", "schedulerAdvanceCommand", "schedulerDispatchReceipt",
		"supersessionCandidateCommand", "supersessionCandidateRecord",
		"supersessionActivationCommand", "supersessionActivationReceipt",
		"replanDelegationIssueCommand", "replanDelegationRecord",
		"replanDelegationRevokeCommand", "replanDelegationRevocationRecord",
		"agentSupersessionCandidateCommand", "agentSupersessionActivationCommand",
		"evidenceReuseContract", "remoteProviderBinding", "remoteProviderBindingRevocation",
		"providerCommitObservation", "remoteCommitObservation", "providerCIObservation",
		"remoteCIObservationReceipt", "providerInputAttestation", "remoteInputAttestation",
		"executionEvidencePage",
		"remoteEvidenceAdoptionCommand", "integrationApprovalCommand"} {
		schema, err := compiler.Compile(id + "#/$defs/" + kind)
		if err != nil {
			panic(err)
		}
		result[kind] = schema
	}
	return result
}

// ValidateExecutionCommand validates raw JSON before typed decoding. A Go
// decoder's case-insensitive fields, duplicate keys or replacement Unicode
// cannot silently broaden the authoritative JSON Schema.
func ValidateExecutionCommand(kind string, source []byte) error {
	_, err := ValidateAndNormalizeExecutionCommand(kind, source)
	return err
}

// ValidateAndNormalizeExecutionCommand returns schema-valid canonical JSON for
// typed decoding; integral numeric spellings such as 1.0 become the integer 1.
// UTC strings retain their exact fractional precision.
func ValidateAndNormalizeExecutionCommand(kind string, source []byte) ([]byte, error) {
	schema := executionSchemas[kind]
	if schema == nil {
		return nil, ErrInvalidExecutionJSON
	}
	value, err := executionJSONValue(source)
	if err != nil || schema.Validate(value) != nil || !validateEvidenceSemantics(kind, value) {
		return nil, ErrInvalidExecutionJSON
	}
	var output bytes.Buffer
	if err := appendExecutionJSON(&output, value); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

func validateEvidenceSemantics(kind string, value any) bool {
	record, ok := value.(map[string]any)
	if !ok {
		return kind != "sourceEvidence" && kind != "evidenceAdoption" && kind != "evidenceReuseContract" &&
			kind != "remoteProviderBinding" && kind != "remoteProviderBindingRevocation" &&
			kind != "providerCommitObservation" && kind != "remoteCommitObservation" &&
			kind != "providerCIObservation" && kind != "remoteCIObservationReceipt" &&
			kind != "providerInputAttestation" && kind != "remoteInputAttestation"
	}
	switch kind {
	case "sourceEvidence":
		pins, ok := record["artifactPins"].([]any)
		if !ok || !strictlyOrderedArtifactPins(pins) {
			return false
		}
		unsigned := withoutExecutionFields(record, "sourceEvidenceId", "sourceDigest", "createdAt")
		if executionValueDigest(unsigned) != executionString(record, "sourceDigest") {
			return false
		}
		if executionString(record, "kind") == "repository_commit" {
			size := 64
			if executionString(record, "objectFormat") == "sha1" {
				size = 40
			}
			if len(executionString(record, "commit")) != size || len(executionString(record, "tree")) != size {
				return false
			}
		}
	case "evidenceAdoption":
		proofs, ok := record["proofs"].([]any)
		if !ok || !strictlyOrderedProofs(proofs) {
			return false
		}
		allowed := map[string]map[string]bool{
			"accepted_result":   {"result_review": true},
			"verified_output":   {"ci_observation_receipt": true, "verification_receipt": true},
			"integrated_commit": {"integration_receipt": true},
		}[executionString(record, "gate")]
		if allowed == nil {
			return false
		}
		seenOperations := map[string]bool{}
		for _, entry := range proofs {
			proof, ok := entry.(map[string]any)
			operationID := executionString(proof, "operationId")
			if !ok || !allowed[executionString(proof, "kind")] || seenOperations[operationID] {
				return false
			}
			seenOperations[operationID] = true
		}
		if executionValueDigest(proofs) != executionString(record, "proofSetDigest") {
			return false
		}
		operation := withoutExecutionFields(record, "operationDigest", "adoptionDigest", "createdAt")
		if executionValueDigest(operation) != executionString(record, "operationDigest") {
			return false
		}
		adoption := withoutExecutionFields(record, "adoptionDigest")
		if executionValueDigest(adoption) != executionString(record, "adoptionDigest") {
			return false
		}
	case "evidenceReuseContract":
		return validateEvidenceReuseContract(value)
	case "remoteProviderBinding":
		origin, err := url.Parse(executionString(record, "providerOrigin"))
		loopback := err == nil && origin.Scheme == "http" &&
			(origin.Hostname() == "127.0.0.1" || origin.Hostname() == "::1")
		if err != nil || (origin.Scheme != "https" && !loopback) || origin.Host == "" ||
			origin.User != nil || origin.RawQuery != "" || origin.Fragment != "" ||
			origin.Path != "" || origin.RawPath != "" ||
			executionString(record, "providerOrigin") != origin.Scheme+"://"+origin.Host {
			return false
		}
		checks, ok := record["ciChecks"].([]any)
		if !ok {
			return false
		}
		previous := ""
		seenProfiles := map[string]bool{}
		for index, entry := range checks {
			check, ok := entry.(map[string]any)
			key := executionString(check, "checkKey")
			profile := executionString(check, "profileId")
			if !ok || (index > 0 && previous >= key) || seenProfiles[profile] {
				return false
			}
			previous = key
			seenProfiles[profile] = true
		}
		unsigned := withoutExecutionFields(record, "bindingDigest", "createdAt")
		if executionValueDigest(unsigned) != executionString(record, "bindingDigest") {
			return false
		}
	case "remoteProviderBindingRevocation":
		unsigned := withoutExecutionFields(record, "revocationDigest", "revokedAt")
		if executionValueDigest(unsigned) != executionString(record, "revocationDigest") {
			return false
		}
	case "providerCommitObservation":
		if !validRemoteObjectFormat(record, "baseCommit", "commit", "tree") {
			return false
		}
		unsigned := withoutExecutionFields(record, "providerObservationDigest")
		if executionValueDigest(unsigned) != executionString(record, "providerObservationDigest") {
			return false
		}
	case "providerCIObservation":
		unsigned := withoutExecutionFields(record, "providerObservationDigest")
		if executionValueDigest(unsigned) != executionString(record, "providerObservationDigest") {
			return false
		}
	case "remoteCommitObservation":
		if !validRemoteObjectFormat(record, "baseCommit", "commit", "tree") {
			return false
		}
		unsigned := withoutExecutionFields(record, "observationDigest")
		if executionValueDigest(unsigned) != executionString(record, "observationDigest") {
			return false
		}
	case "remoteCIObservationReceipt":
		unsigned := withoutExecutionFields(record, "receiptDigest")
		if executionValueDigest(unsigned) != executionString(record, "receiptDigest") {
			return false
		}
	case "providerInputAttestation":
		return validateRemoteInputAttestation(record, false)
	case "remoteInputAttestation":
		return validateRemoteInputAttestation(record, true)
	}
	return true
}

func validateRemoteInputAttestation(record map[string]any, retained bool) bool {
	commit, tree := executionString(record, "commit"), executionString(record, "tree")
	if len(commit) != len(tree) || (len(commit) != 40 && len(commit) != 64) {
		return false
	}
	entries, ok := record["inputs"].([]any)
	if !ok {
		return false
	}
	logical := make([]any, 0, len(entries))
	previous := ""
	seenAdoptions := map[string]bool{}
	for index, candidate := range entries {
		entry, ok := candidate.(map[string]any)
		if !ok {
			return false
		}
		adoption := executionString(entry, "adoptionId")
		input, ok := entry["reuseInput"].(map[string]any)
		if !ok {
			return false
		}
		slot := executionString(input, "inputSlot")
		if (index > 0 && previous >= slot) || seenAdoptions[adoption] {
			return false
		}
		previous, seenAdoptions[adoption] = slot, true
		producer, ok := input["producer"].(map[string]any)
		if !ok || executionString(producer, "kind") != "adopted_evidence" {
			return false
		}
		edge, ok := producer["edge"].(map[string]any)
		if !ok || executionString(edge, "toNodeKey") != executionString(record, "nodeKey") {
			return false
		}
		bindings, ok := edge["bindings"].([]any)
		if !ok {
			return false
		}
		matches := 0
		for _, candidate := range bindings {
			binding, ok := candidate.(map[string]any)
			if ok && executionString(binding, "inputSlot") == slot {
				matches++
			}
		}
		if matches != 1 {
			return false
		}
		logical = append(logical, input)
	}
	if executionValueDigest(logical) != executionString(record, "remoteInputEvidenceDigest") {
		return false
	}
	provider := record
	if retained {
		provider = map[string]any{}
		for _, key := range []string{"version", "operationId", "attestationId",
			"providerRepositoryId", "nodeKey", "commit", "tree", "inputs",
			"remoteInputEvidenceDigest", "providerAttestationDigest", "attestedAt"} {
			provider[key] = record[key]
		}
	}
	unsignedProvider := withoutExecutionFields(provider, "providerAttestationDigest")
	if executionValueDigest(unsignedProvider) != executionString(record, "providerAttestationDigest") {
		return false
	}
	if retained {
		unsigned := withoutExecutionFields(record, "attestationDigest")
		if executionValueDigest(unsigned) != executionString(record, "attestationDigest") {
			return false
		}
	}
	return true
}

func validRemoteObjectFormat(record map[string]any, keys ...string) bool {
	size := 64
	if executionString(record, "objectFormat") == "sha1" {
		size = 40
	}
	for _, key := range keys {
		if len(executionString(record, key)) != size {
			return false
		}
	}
	return true
}

func executionString(record map[string]any, key string) string {
	value, _ := record[key].(string)
	return value
}

func withoutExecutionFields(record map[string]any, fields ...string) map[string]any {
	excluded := map[string]bool{}
	for _, field := range fields {
		excluded[field] = true
	}
	clone := make(map[string]any, len(record))
	for key, value := range record {
		if !excluded[key] {
			clone[key] = value
		}
	}
	return clone
}

func executionValueDigest(value any) string {
	var canonical bytes.Buffer
	if appendExecutionJSON(&canonical, value) != nil {
		return ""
	}
	hash := sha256.Sum256(canonical.Bytes())
	return hex.EncodeToString(hash[:])
}

func validateEvidenceReuseContract(value any) bool {
	record, ok := value.(map[string]any)
	if !ok {
		return false
	}
	inputs, ok := record["reuseInputs"].([]any)
	if !ok {
		return false
	}
	node, ok := record["node"].(map[string]any)
	if !ok || executionString(node, "nodeKey") != executionString(record, "nodeKey") {
		return false
	}
	nodeInputs, ok := node["inputs"].([]any)
	if !ok {
		return false
	}
	previous := ""
	for index, entry := range inputs {
		input, ok := entry.(map[string]any)
		if !ok {
			return false
		}
		inputSlot := executionString(input, "inputSlot")
		if index > 0 && previous >= inputSlot {
			return false
		}
		previous = inputSlot
		artifact, ok := input["artifact"].(map[string]any)
		if !ok {
			return false
		}
		slotKind := ""
		for _, candidate := range nodeInputs {
			slot, ok := candidate.(map[string]any)
			if ok && executionString(slot, "slotKey") == inputSlot {
				slotKind = executionString(slot, "kind")
			}
		}
		if slotKind == "" || slotKind != executionString(artifact, "kind") {
			return false
		}
		producer, ok := input["producer"].(map[string]any)
		if !ok {
			return false
		}
		switch executionString(producer, "kind") {
		case "adopted_evidence":
			edge, ok := producer["edge"].(map[string]any)
			if !ok || executionString(edge, "toNodeKey") != executionString(record, "nodeKey") {
				return false
			}
			bindings, ok := edge["bindings"].([]any)
			if !ok {
				return false
			}
			matches := 0
			for _, candidate := range bindings {
				binding, ok := candidate.(map[string]any)
				if ok && executionString(binding, "inputSlot") == inputSlot {
					matches++
				}
			}
			if matches != 1 {
				return false
			}
		case "external_result":
			external, ok := producer["externalInput"].(map[string]any)
			if !ok || executionString(external, "nodeKey") != executionString(record, "nodeKey") ||
				executionString(external, "inputSlot") != inputSlot ||
				executionString(external, "contentDigest") != executionString(artifact, "contentDigest") ||
				executionString(external, "kind") != executionString(artifact, "kind") {
				return false
			}
		default:
			return false
		}
	}
	if executionValueDigest(inputs) != executionString(record, "reuseInputEvidenceDigest") {
		return false
	}
	reusable := map[string]any{
		"node":                     record["node"],
		"task":                     record["task"],
		"integrationPolicy":        record["integrationPolicy"],
		"reuseInputEvidenceDigest": record["reuseInputEvidenceDigest"],
	}
	if executionValueDigest(reusable) != executionString(record, "nodeReuseContractDigest") {
		return false
	}
	contract := withoutExecutionFields(record, "reuseContractId", "contractDigest", "createdAt")
	if executionValueDigest(contract) != executionString(record, "contractDigest") {
		return false
	}
	identity := map[string]any{
		"adoptionId":     record["adoptionId"],
		"contractDigest": record["contractDigest"],
	}
	return executionString(record, "reuseContractId") == "reuse_"+executionValueDigest(identity)
}

func strictlyOrderedArtifactPins(entries []any) bool {
	previous := ""
	first := true
	seenSlots := map[string]bool{}
	seenArtifacts := map[string]bool{}
	for _, entry := range entries {
		record, ok := entry.(map[string]any)
		if !ok {
			return false
		}
		slot := executionString(record, "outputSlot")
		artifact := executionString(record, "artifactId")
		current := slot + "\x00" + artifact
		if (!first && previous >= current) || seenSlots[slot] || seenArtifacts[artifact] {
			return false
		}
		previous, first = current, false
		seenSlots[slot], seenArtifacts[artifact] = true, true
	}
	return true
}

func strictlyOrderedProofs(entries []any) bool {
	previous := ""
	first := true
	seenOperations := map[string]bool{}
	for _, entry := range entries {
		record, ok := entry.(map[string]any)
		if !ok {
			return false
		}
		operation := executionString(record, "operationId")
		current := executionString(record, "kind") + "\x00" + operation
		if (!first && previous >= current) || seenOperations[operation] {
			return false
		}
		previous, first = current, false
		seenOperations[operation] = true
	}
	return true
}

// CanonicalExecutionJSON matches executionOperationDigest's integer-only JSON
// encoding, UTF-16 property ordering and exact Unicode/timestamp strings.
// It does not replace operation-specific schema or authorization validation.
func CanonicalExecutionJSON(source []byte) ([]byte, error) {
	value, err := executionJSONValue(source)
	if err != nil {
		return nil, err
	}
	var output bytes.Buffer
	if err := appendExecutionJSON(&output, value); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

func ExecutionDigest(source []byte) (string, error) {
	canonical, err := CanonicalExecutionJSON(source)
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256(canonical)
	return hex.EncodeToString(hash[:]), nil
}

func executionJSONValue(source []byte) (any, error) {
	if len(source) > 512<<10 || !utf8.Valid(source) || !jsonStringsHaveValidUnicodeEscapes(source) ||
		!bridgeJSONWithinResourceBounds(source) {
		return nil, ErrInvalidExecutionJSON
	}
	value, err := decodeSingleJSONValue(source)
	if err != nil {
		return nil, ErrInvalidExecutionJSON
	}
	count := 0
	if !executionValueWithinBounds(value, 0, &count) {
		return nil, ErrInvalidExecutionJSON
	}
	// Use the same bounded canonical traversal for both schema validation and
	// digesting, so unsafe numeric or object-key forms fail before typed decode.
	var check bytes.Buffer
	if err := appendExecutionJSON(&check, value); err != nil {
		return nil, err
	}
	if check.Len() > 512<<10 {
		return nil, ErrInvalidExecutionJSON
	}
	return value, nil
}

func executionValueWithinBounds(value any, depth int, count *int) bool {
	*count++
	if depth > 24 || *count > 30000 {
		return false
	}
	switch v := value.(type) {
	case []any:
		for index, child := range v {
			if !executionValueWithinBounds(strconv.Itoa(index), depth+1, count) ||
				!executionValueWithinBounds(child, depth+1, count) {
				return false
			}
		}
	case map[string]any:
		for key, child := range v {
			if !executionValueWithinBounds(key, depth+1, count) || !executionValueWithinBounds(child, depth+1, count) {
				return false
			}
		}
	}
	return true
}

func appendExecutionJSON(out *bytes.Buffer, value any) error {
	switch v := value.(type) {
	case nil:
		out.WriteString("null")
	case bool:
		out.WriteString(strconv.FormatBool(v))
	case string:
		appendExecutionString(out, v)
	case json.Number:
		number, ok := new(big.Rat).SetString(string(v))
		if !ok || !number.IsInt() || !number.Num().IsInt64() {
			return ErrInvalidExecutionJSON
		}
		integer := number.Num().Int64()
		if integer < -maxSafeJSONInteger || integer > maxSafeJSONInteger {
			return ErrInvalidExecutionJSON
		}
		out.WriteString(strconv.FormatInt(integer, 10))
	case []any:
		out.WriteByte('[')
		for index, entry := range v {
			if index > 0 {
				out.WriteByte(',')
			}
			if err := appendExecutionJSON(out, entry); err != nil {
				return err
			}
		}
		out.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(v))
		for key := range v {
			if key == "__proto__" || key == "constructor" || key == "prototype" {
				return ErrInvalidExecutionJSON
			}
			keys = append(keys, key)
		}
		sort.Slice(keys, func(i, j int) bool {
			return slices.Compare(utf16.Encode([]rune(keys[i])), utf16.Encode([]rune(keys[j]))) < 0
		})
		out.WriteByte('{')
		for index, key := range keys {
			if index > 0 {
				out.WriteByte(',')
			}
			appendExecutionString(out, key)
			out.WriteByte(':')
			if err := appendExecutionJSON(out, v[key]); err != nil {
				return err
			}
		}
		out.WriteByte('}')
	default:
		return ErrInvalidExecutionJSON
	}
	return nil
}

func appendExecutionString(out *bytes.Buffer, value string) {
	const digits = "0123456789abcdef"
	out.WriteByte('"')
	for _, r := range value {
		switch r {
		case '"', '\\':
			out.WriteByte('\\')
			out.WriteRune(r)
		case '\b':
			out.WriteString(`\b`)
		case '\f':
			out.WriteString(`\f`)
		case '\n':
			out.WriteString(`\n`)
		case '\r':
			out.WriteString(`\r`)
		case '\t':
			out.WriteString(`\t`)
		default:
			if r < 0x20 {
				out.WriteString(`\u00`)
				out.WriteByte(digits[r>>4])
				out.WriteByte(digits[r&15])
			} else {
				out.WriteRune(r)
			}
		}
	}
	out.WriteByte('"')
}

// Code generated from JSON Schema; DO NOT EDIT.

package runtimecontracts

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"io"
	"math"
	"math/big"
	"strconv"
	"strings"
	"unicode/utf8"

	contracts "convenewire.dev/contracts/generated/go"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

const bridgeSchemaID = "https://agentroom.dev/schemas/bridge/messages.schema.json"

//go:embed bridge-schema.json
var bridgeSchemaSource []byte

const bridgeCanonicalPropertyTreesSource = "{\"run.activity\":{\"p\":{\"protocolVersion\":{},\"messageId\":{},\"timestamp\":{},\"type\":{},\"payload\":{\"p\":{\"runId\":{},\"traceId\":{},\"agentId\":{},\"sequence\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"activityId\":{},\"kind\":{},\"phase\":{},\"label\":{},\"content\":{},\"reset\":{}}}}},\"run.output_delta\":{\"p\":{\"protocolVersion\":{},\"messageId\":{},\"timestamp\":{},\"type\":{},\"payload\":{\"p\":{\"runId\":{},\"traceId\":{},\"agentId\":{},\"sequence\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"content\":{},\"reset\":{}}}}},\"bridge.hello\":{\"p\":{\"protocolVersion\":{},\"messageId\":{},\"timestamp\":{},\"type\":{},\"payload\":{\"p\":{\"governedExecution\":{\"p\":{\"version\":{\"n\":true,\"l\":\"1\",\"u\":\"1\"},\"workspaceBoundary\":{},\"preventivePathEnforcement\":{},\"operations\":{\"i\":{}},\"readyGrants\":{\"i\":{\"p\":{\"grant\":{\"p\":{\"grantId\":{},\"revision\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"digest\":{},\"expiresAt\":{}}},\"repositoryId\":{},\"bindingId\":{},\"deviceId\":{},\"agentId\":{},\"planId\":{},\"nodeKey\":{},\"operations\":{\"i\":{}},\"runtimeProfile\":{\"p\":{\"profileId\":{},\"revision\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"digest\":{}}},\"verificationProfiles\":{\"i\":{\"p\":{\"profileId\":{},\"revision\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"digest\":{}}}},\"scopePolicy\":{\"p\":{\"access\":{},\"allowedPaths\":{\"i\":{}},\"forbiddenPaths\":{\"i\":{}},\"requirePreventivePathEnforcement\":{}}},\"integrationTargets\":{\"i\":{\"p\":{\"repositoryId\":{},\"targetRef\":{},\"expectedCommit\":{}}}},\"issuedAt\":{},\"revokedAt\":{}}}}}},\"deviceId\":{},\"connectionEpoch\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"bridgeVersion\":{},\"sourceCommit\":{},\"executableSha256\":{},\"supportsAgentProvisioning\":{},\"supportedProtocolVersions\":{\"i\":{}}}}}},\"bridge.heartbeat\":{\"p\":{\"protocolVersion\":{},\"messageId\":{},\"timestamp\":{},\"type\":{},\"payload\":{\"p\":{\"deviceId\":{},\"connectionEpoch\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"}}}}},\"agent.publish\":{\"p\":{\"protocolVersion\":{},\"messageId\":{},\"timestamp\":{},\"type\":{},\"payload\":{\"p\":{\"teamId\":{},\"agentId\":{},\"ownerMemberId\":{},\"deviceId\":{},\"name\":{},\"role\":{},\"capabilities\":{\"p\":{\"governedExecution\":{\"p\":{\"version\":{\"n\":true,\"l\":\"1\",\"u\":\"1\"},\"workspaceBoundary\":{},\"preventivePathEnforcement\":{},\"operations\":{\"i\":{}},\"readyGrants\":{\"i\":{\"p\":{\"grant\":{\"p\":{\"grantId\":{},\"revision\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"digest\":{},\"expiresAt\":{}}},\"repositoryId\":{},\"bindingId\":{},\"deviceId\":{},\"agentId\":{},\"planId\":{},\"nodeKey\":{},\"operations\":{\"i\":{}},\"runtimeProfile\":{\"p\":{\"profileId\":{},\"revision\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"digest\":{}}},\"verificationProfiles\":{\"i\":{\"p\":{\"profileId\":{},\"revision\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"digest\":{}}}},\"scopePolicy\":{\"p\":{\"access\":{},\"allowedPaths\":{\"i\":{}},\"forbiddenPaths\":{\"i\":{}},\"requirePreventivePathEnforcement\":{}}},\"integrationTargets\":{\"i\":{\"p\":{\"repositoryId\":{},\"targetRef\":{},\"expectedCommit\":{}}}},\"issuedAt\":{},\"revokedAt\":{}}}}}},\"invocationMode\":{},\"supportsStart\":{},\"supportsResume\":{},\"supportsStreaming\":{},\"supportsInterrupt\":{},\"supportsHandoff\":{},\"supportsRoomContextCoverage\":{},\"supportsWorkspaceLeases\":{},\"supportsArtifactPublication\":{},\"supportsArtifactMaterialization\":{}}},\"runtimePolicy\":{\"p\":{\"filesystemAccess\":{}}},\"runtimeScopeId\":{},\"workspaceRef\":{},\"workspaceAlias\":{},\"workspaceGeneration\":{}}}}},\"agent.status\":{\"p\":{\"protocolVersion\":{},\"messageId\":{},\"timestamp\":{},\"type\":{},\"payload\":{\"p\":{\"agentId\":{},\"deviceId\":{},\"connectionEpoch\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"status\":{},\"reason\":{}}}}},\"agent.provision.requested\":{\"p\":{\"protocolVersion\":{},\"messageId\":{},\"timestamp\":{},\"type\":{},\"payload\":{\"p\":{\"requestId\":{},\"deviceId\":{},\"templateAgentId\":{},\"agentId\":{},\"name\":{},\"role\":{},\"managementCode\":{}}}}},\"agent.provision.result\":{\"p\":{\"protocolVersion\":{},\"messageId\":{},\"timestamp\":{},\"type\":{},\"payload\":{\"p\":{\"requestId\":{},\"deviceId\":{},\"templateAgentId\":{},\"agentId\":{},\"status\":{},\"reason\":{}}}}},\"run.requested\":{\"p\":{\"protocolVersion\":{},\"messageId\":{},\"timestamp\":{},\"type\":{},\"payload\":{\"p\":{\"runId\":{},\"traceId\":{},\"roomId\":{},\"taskId\":{},\"session\":{\"p\":{\"scope\":{},\"resumePolicy\":{},\"contextCursor\":{\"n\":true,\"l\":\"0\",\"u\":\"9007199254740991\"},\"runtimeScopeId\":{}}},\"triggerMessageId\":{},\"requesterMemberId\":{},\"targetAgentId\":{},\"targetAgentName\":{},\"deliveryAttemptId\":{},\"idempotencyKey\":{},\"parentRunId\":{},\"instruction\":{},\"contextMessages\":{\"i\":{\"p\":{\"messageId\":{},\"senderId\":{},\"senderName\":{},\"content\":{},\"sequence\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"}}}},\"roomContextBundle\":{\"p\":{\"targetThroughSequence\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"priorContextThroughSequence\":{\"n\":true,\"l\":\"0\",\"u\":\"9007199254740991\"},\"requestMessageId\":{},\"checkpoint\":{\"p\":{\"checkpointId\":{},\"fromSequenceExclusive\":{\"n\":true,\"l\":\"0\",\"u\":\"9007199254740991\"},\"throughSequence\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"summary\":{},\"sourceMessageCount\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"sourceDigest\":{},\"promptVersion\":{},\"modelFingerprint\":{},\"buildKind\":{},\"provenanceMessageIds\":{\"i\":{}}}},\"rawTail\":{\"p\":{\"fromSequenceExclusive\":{\"n\":true,\"l\":\"0\",\"u\":\"9007199254740991\"},\"throughSequenceInclusive\":{\"n\":true,\"l\":\"0\",\"u\":\"9007199254740991\"},\"messageCount\":{\"n\":true,\"l\":\"0\",\"u\":\"12\"},\"utf8Bytes\":{\"n\":true,\"l\":\"0\",\"u\":\"10240\"},\"messages\":{\"i\":{\"p\":{\"messageId\":{},\"senderId\":{},\"senderName\":{},\"content\":{},\"sequence\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"}}}}}}}},\"contextPlan\":{\"p\":{\"roomMemory\":{\"p\":{\"summary\":{},\"sourceCursor\":{\"n\":true,\"l\":\"0\",\"u\":\"9007199254740991\"},\"revision\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"projectionKind\":{},\"sourceMessageIds\":{\"i\":{}}}},\"taskMemory\":{\"p\":{\"summary\":{},\"sourceCursor\":{\"n\":true,\"l\":\"0\",\"u\":\"9007199254740991\"},\"revision\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"projectionKind\":{},\"sourceMessageIds\":{\"i\":{}}}},\"resultEvidence\":{\"p\":{\"revision\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"deliveryKind\":{},\"fromRevision\":{\"n\":true,\"l\":\"0\",\"u\":\"9007199254740991\"},\"throughRevision\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"hasMore\":{},\"artifactRefs\":{\"i\":{\"p\":{\"artifactId\":{},\"artifactRevision\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"relations\":{\"i\":{\"p\":{\"relationId\":{},\"type\":{},\"targetArtifactId\":{}}}},\"type\":{},\"workspaceRef\":{},\"repository\":{},\"path\":{},\"commitSha\":{},\"branch\":{},\"content\":{\"p\":{\"contentId\":{},\"sizeBytes\":{\"n\":true,\"l\":\"1\",\"u\":\"4194304\"},\"mediaType\":{},\"sha256\":{},\"logicalAlias\":{}}},\"title\":{},\"summary\":{},\"sourceRunId\":{},\"createdByMemberId\":{},\"createdByAgentId\":{},\"createdAt\":{}}}}}},\"longTermMemory\":{\"p\":{\"room\":{\"p\":{\"revision\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"activeComplete\":{},\"entries\":{\"i\":{\"p\":{\"memoryId\":{},\"type\":{},\"content\":{},\"state\":{},\"revision\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"supersedesMemoryId\":{},\"sourceMessageIds\":{\"i\":{}},\"sourceArtifactIds\":{\"i\":{}},\"sourceRunIds\":{\"i\":{}},\"sourceDiscussionIds\":{\"i\":{}}}}}}},\"task\":{\"p\":{\"revision\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"activeComplete\":{},\"entries\":{\"i\":{\"p\":{\"memoryId\":{},\"type\":{},\"content\":{},\"state\":{},\"revision\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"supersedesMemoryId\":{},\"sourceMessageIds\":{\"i\":{}},\"sourceArtifactIds\":{\"i\":{}},\"sourceRunIds\":{\"i\":{}},\"sourceDiscussionIds\":{\"i\":{}}}}}}}}}}},\"contextManifest\":{\"p\":{\"execution\":{\"p\":{\"version\":{\"n\":true,\"l\":\"1\",\"u\":\"1\"},\"scope\":{\"p\":{\"planId\":{},\"planRevision\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"planDigest\":{},\"approvalOperationId\":{},\"planControlRevision\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"nodeKey\":{},\"dispatchGeneration\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"roomId\":{},\"taskId\":{},\"taskRevision\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"definitionRevision\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"criteriaRevision\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"runId\":{},\"agentId\":{},\"deviceId\":{}}},\"repository\":{\"p\":{\"repositoryId\":{},\"bindingId\":{},\"baseCommit\":{},\"grantId\":{},\"grantRevision\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"runtimeProfileId\":{},\"runtimeProfileDigest\":{}}},\"grant\":{\"p\":{\"grantId\":{},\"revision\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"digest\":{},\"expiresAt\":{}}},\"workspace\":{\"p\":{\"leaseId\":{},\"workspaceRef\":{},\"workspaceGeneration\":{},\"mode\":{},\"issuedAt\":{},\"expiresAt\":{}}},\"inputs\":{\"i\":{\"p\":{\"bindingId\":{},\"planId\":{},\"planRevision\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"edgeKey\":{},\"gate\":{},\"gateOperationId\":{},\"gateDigest\":{},\"sourceTaskId\":{},\"sourceDefinitionRevision\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"sourceCriteriaRevision\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"sourceResultId\":{},\"sourceResultVersion\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"sourceAuthority\":{\"p\":{\"sourceEvidenceId\":{},\"sourceDigest\":{},\"adoptionId\":{},\"adoptionDigest\":{}}},\"sourceOutputSlot\":{},\"artifact\":{\"p\":{\"artifactId\":{},\"artifactRevision\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"contentDigest\":{},\"byteLength\":{\"n\":true,\"l\":\"0\",\"u\":\"67108864\"},\"kind\":{}}},\"repositoryId\":{},\"sourceCommit\":{},\"sourceTree\":{},\"destinationTaskId\":{},\"destinationRunId\":{},\"destinationAgentId\":{},\"destinationDeviceId\":{},\"inputSlot\":{},\"issuedAt\":{},\"expiresAt\":{}}}},\"inputDigest\":{},\"scopePolicy\":{\"p\":{\"access\":{},\"allowedPaths\":{\"i\":{}},\"forbiddenPaths\":{\"i\":{}},\"requirePreventivePathEnforcement\":{}}},\"verificationProfiles\":{\"i\":{\"p\":{\"profileId\":{},\"revision\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"digest\":{},\"required\":{}}}},\"outputs\":{\"i\":{\"p\":{\"slotKey\":{},\"kind\":{},\"required\":{}}}},\"capture\":{\"p\":{\"operationId\":{},\"rootTaskId\":{},\"outputs\":{\"i\":{\"p\":{\"slotKey\":{},\"title\":{},\"summary\":{},\"path\":{}}}}}},\"deadline\":{},\"manifestDigest\":{}}},\"manifestVersion\":{},\"runId\":{},\"taskId\":{},\"taskRevision\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"definitionRevision\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"criteriaRevision\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"goal\":{},\"criteria\":{\"i\":{\"p\":{\"criterionKey\":{},\"description\":{},\"required\":{},\"ordinal\":{\"n\":true,\"l\":\"1\",\"u\":\"100\"}}}},\"target\":{\"p\":{\"agentId\":{},\"deviceId\":{},\"runtimeKind\":{},\"workspaceAlias\":{}}},\"included\":{\"p\":{\"messageIds\":{\"i\":{}},\"artifactIds\":{\"i\":{}},\"memoryIds\":{\"i\":{}},\"parentRunIds\":{\"i\":{}},\"roomContextRevision\":{\"n\":true,\"l\":\"0\",\"u\":\"9007199254740991\"},\"taskMemoryRevision\":{\"n\":true,\"l\":\"0\",\"u\":\"9007199254740991\"},\"artifactRevision\":{\"n\":true,\"l\":\"0\",\"u\":\"9007199254740991\"}}},\"permissions\":{\"p\":{\"filesystemAccess\":{},\"networkAccess\":{},\"interrupt\":{},\"handoff\":{},\"maxDurationSeconds\":{\"n\":true,\"l\":\"1\",\"u\":\"86400\"}}},\"omittedCategories\":{\"i\":{}},\"recordedAt\":{}}},\"routingAgents\":{\"i\":{\"p\":{\"agentId\":{},\"name\":{}}}},\"deadline\":{}}}}},\"run.accepted\":{\"p\":{\"protocolVersion\":{},\"messageId\":{},\"timestamp\":{},\"type\":{},\"payload\":{\"p\":{\"runId\":{},\"traceId\":{},\"agentId\":{},\"sequence\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"artifactMaterializationError\":{\"p\":{\"code\":{},\"message\":{},\"retryable\":{}}},\"artifactMaterializations\":{\"i\":{\"p\":{\"artifactId\":{},\"contentId\":{},\"sizeBytes\":{\"n\":true,\"l\":\"1\",\"u\":\"4194304\"},\"mediaType\":{},\"sha256\":{},\"logicalAlias\":{},\"materializationState\":{}}}}}}}},\"run.status\":{\"p\":{\"protocolVersion\":{},\"messageId\":{},\"timestamp\":{},\"type\":{},\"payload\":{\"p\":{\"runId\":{},\"traceId\":{},\"agentId\":{},\"sequence\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"status\":{},\"error\":{\"p\":{\"code\":{},\"message\":{},\"details\":{\"p\":{\"category\":{},\"exitCode\":{\"n\":true,\"l\":\"-9007199254740991\",\"u\":\"9007199254740991\"},\"stderrCaptured\":{}}},\"retryable\":{}}},\"session\":{\"p\":{\"disposition\":{},\"contextCursor\":{\"n\":true,\"l\":\"0\",\"u\":\"9007199254740991\"},\"runtimeScopeId\":{},\"resultEvidenceRevision\":{\"n\":true,\"l\":\"0\",\"u\":\"9007199254740991\"},\"roomContextConsumption\":{\"p\":{\"baseContextCursor\":{\"n\":true,\"l\":\"0\",\"u\":\"9007199254740991\"},\"checkpointId\":{},\"rawFromSequenceExclusive\":{\"n\":true,\"l\":\"0\",\"u\":\"9007199254740991\"},\"rawThroughSequenceInclusive\":{\"n\":true,\"l\":\"0\",\"u\":\"9007199254740991\"},\"rawMessageCount\":{\"n\":true,\"l\":\"0\",\"u\":\"12\"},\"coverageThroughSequence\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"}}}}},\"clarification\":{\"p\":{\"kind\":{},\"question\":{},\"choices\":{\"i\":{}}}}}}}},\"run.reply\":{\"p\":{\"protocolVersion\":{},\"messageId\":{},\"timestamp\":{},\"type\":{},\"payload\":{\"p\":{\"runId\":{},\"traceId\":{},\"agentId\":{},\"sequence\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"content\":{},\"assessment\":{\"p\":{\"goalSatisfied\":{},\"confidence\":{\"d\":true,\"l\":\"0\",\"u\":\"1\"},\"resolvedQuestionIds\":{\"i\":{}},\"openQuestions\":{\"i\":{\"p\":{\"id\":{},\"question\":{},\"importance\":{}}}},\"newEvidenceRefs\":{\"i\":{}},\"disagreementRemaining\":{},\"newInformationAdded\":{},\"reviewerApproved\":{},\"recommendation\":{}}}}}}},\"run.cancel_requested\":{\"p\":{\"protocolVersion\":{},\"messageId\":{},\"timestamp\":{},\"type\":{},\"payload\":{\"p\":{\"runId\":{},\"traceId\":{},\"agentId\":{},\"reason\":{}}}}},\"run.handoff_requested\":{\"p\":{\"protocolVersion\":{},\"messageId\":{},\"timestamp\":{},\"type\":{},\"payload\":{\"p\":{\"runId\":{},\"traceId\":{},\"agentId\":{},\"sequence\":{\"n\":true,\"l\":\"1\",\"u\":\"9007199254740991\"},\"handoffId\":{},\"targetAgentId\":{},\"summary\":{}}}}}}"

const maxSafeJSONInteger int64 = 9007199254740991

const maxJSONNumberLexemeLength = 256

const maxJSONNumberExponentMagnitude = 512

const maxJSONDepth = 64

const maxJSONTotalNodes = 8192

const maxJSONNumbers = 4096

var ErrInvalidBridgeMessage = errors.New("Bridge message does not match the authoritative schema")

var bridgeSchema = mustCompileBridgeSchema()

var bridgeCanonicalPropertyTrees = mustDecodeCanonicalPropertyTrees()

type canonicalPropertyTree struct {
	Properties map[string]canonicalPropertyTree `json:"p,omitempty"`
	Items      *canonicalPropertyTree           `json:"i,omitempty"`
	Additional *canonicalPropertyTree           `json:"a,omitempty"`
	Integer    bool                             `json:"n,omitempty"`
	Number     bool                             `json:"d,omitempty"`
	Minimum    string                           `json:"l,omitempty"`
	Maximum    string                           `json:"u,omitempty"`
}

func ValidateBridgeMessage(source []byte) error {
	_, err := ValidateAndNormalizeBridgeMessage(source)
	return err
}

func ValidateAndNormalizeBridgeMessage(source []byte) ([]byte, error) {
	if !utf8.Valid(source) ||
		!jsonStringsHaveValidUnicodeEscapes(source) ||
		!bridgeJSONWithinResourceBounds(source) {
		return nil, ErrInvalidBridgeMessage
	}
	value, err := decodeSingleJSONValue(source)
	if err != nil || bridgeSchema.Validate(value) != nil {
		return nil, ErrInvalidBridgeMessage
	}
	envelope, ok := value.(map[string]any)
	if !ok {
		return nil, ErrInvalidBridgeMessage
	}
	messageType, ok := envelope["type"].(string)
	if !ok {
		return nil, ErrInvalidBridgeMessage
	}
	propertyTree, ok := bridgeCanonicalPropertyTrees[messageType]
	if !ok || containsNonCanonicalProperty(value, propertyTree) {
		return nil, ErrInvalidBridgeMessage
	}
	normalized, err := normalizeDeclaredNumbers(value, propertyTree)
	if err != nil {
		return nil, ErrInvalidBridgeMessage
	}
	encoded, err := json.Marshal(normalized)
	if err != nil {
		return nil, ErrInvalidBridgeMessage
	}
	return encoded, nil
}

func jsonStringsHaveValidUnicodeEscapes(source []byte) bool {
	inString := false
	for index := 0; index < len(source); {
		current := source[index]
		if !inString {
			if current == '"' {
				inString = true
			}
			index++
			continue
		}
		if current == '"' {
			inString = false
			index++
			continue
		}
		if current != '\\' {
			if current < 0x20 {
				return false
			}
			index++
			continue
		}
		if index+1 >= len(source) {
			return false
		}
		escape := source[index+1]
		if escape != 'u' {
			switch escape {
			case '"', '\\', '/', 'b', 'f', 'n', 'r', 't':
				index += 2
				continue
			default:
				return false
			}
		}
		codeUnit, ok := jsonEscapedCodeUnit(source, index)
		if !ok {
			return false
		}
		if codeUnit >= 0xd800 && codeUnit <= 0xdbff {
			low, ok := jsonEscapedCodeUnit(source, index+6)
			if !ok || low < 0xdc00 || low > 0xdfff {
				return false
			}
			index += 12
			continue
		}
		if codeUnit >= 0xdc00 && codeUnit <= 0xdfff {
			return false
		}
		index += 6
	}
	return !inString
}

func jsonEscapedCodeUnit(source []byte, escapeIndex int) (uint16, bool) {
	if escapeIndex < 0 || escapeIndex+6 > len(source) ||
		source[escapeIndex] != '\\' || source[escapeIndex+1] != 'u' {
		return 0, false
	}
	var codeUnit uint16
	for index := escapeIndex + 2; index < escapeIndex+6; index++ {
		digit, ok := jsonHexNibble(source[index])
		if !ok {
			return 0, false
		}
		codeUnit = codeUnit*16 + uint16(digit)
	}
	return codeUnit, true
}

func jsonHexNibble(value byte) (byte, bool) {
	switch {
	case value >= '0' && value <= '9':
		return value - '0', true
	case value >= 'A' && value <= 'F':
		return value - 'A' + 10, true
	case value >= 'a' && value <= 'f':
		return value - 'a' + 10, true
	default:
		return 0, false
	}
}

func bridgeJSONWithinResourceBounds(source []byte) bool {
	type jsonContainerState struct {
		Object       bool
		ExpectingKey bool
		Keys         map[string]struct{}
	}
	decoder := json.NewDecoder(bytes.NewReader(source))
	decoder.UseNumber()
	containers := []jsonContainerState{}
	totalNodes := 0
	numberCount := 0
	rootValues := 0
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return false
		}
		if delimiter, ok := token.(json.Delim); ok &&
			(delimiter == '}' || delimiter == ']') {
			if len(containers) == 0 {
				return false
			}
			current := containers[len(containers)-1]
			if (delimiter == '}') != current.Object ||
				(current.Object && !current.ExpectingKey) {
				return false
			}
			containers = containers[:len(containers)-1]
			continue
		}
		if len(containers) == 0 {
			rootValues++
		} else {
			parent := &containers[len(containers)-1]
			if parent.Object && parent.ExpectingKey {
				key, ok := token.(string)
				if !ok {
					return false
				}
				if _, duplicate := parent.Keys[key]; duplicate {
					return false
				}
				if parent.Keys == nil {
					parent.Keys = make(map[string]struct{})
				}
				parent.Keys[key] = struct{}{}
				parent.ExpectingKey = false
				continue
			}
			if parent.Object {
				parent.ExpectingKey = true
			}
		}
		totalNodes++
		if totalNodes > maxJSONTotalNodes ||
			len(containers)+1 > maxJSONDepth {
			return false
		}
		switch typed := token.(type) {
		case json.Number:
			numberCount++
			if numberCount > maxJSONNumbers ||
				!jsonNumberWithinResourceBounds(typed.String()) {
				return false
			}
		case json.Delim:
			if typed != '{' && typed != '[' {
				return false
			}
			containers = append(containers, jsonContainerState{
				Object:       typed == '{',
				ExpectingKey: typed == '{',
			})
		}
	}
	return rootValues == 1 && len(containers) == 0
}

func jsonNumberWithinResourceBounds(source string) bool {
	if len(source) > maxJSONNumberLexemeLength {
		return false
	}
	exponentIndex := strings.IndexAny(source, "eE")
	if exponentIndex < 0 {
		return true
	}
	exponent := source[exponentIndex+1:]
	if len(exponent) > 0 && (exponent[0] == '+' || exponent[0] == '-') {
		exponent = exponent[1:]
	}
	exponent = strings.TrimLeft(exponent, "0")
	if exponent == "" {
		return true
	}
	if len(exponent) > 3 {
		return false
	}
	magnitude, err := strconv.Atoi(exponent)
	return err == nil && magnitude <= maxJSONNumberExponentMagnitude
}

func DecodeBridgeMessage(source []byte) (any, error) {
	normalized, err := ValidateAndNormalizeBridgeMessage(source)
	if err != nil {
		return nil, err
	}
	var envelope struct {
		Type string `json:"type"`
	}
	if err := decodeNormalizedBridgeMessage(normalized, &envelope); err != nil {
		return nil, ErrInvalidBridgeMessage
	}
	switch envelope.Type {
	case "run.activity":
		var message contracts.RunActivityMessage
		if err := decodeNormalizedBridgeMessage(normalized, &message); err != nil {
			return nil, ErrInvalidBridgeMessage
		}
		return message, nil
	case "run.output_delta":
		var message contracts.RunOutputDeltaMessage
		if err := decodeNormalizedBridgeMessage(normalized, &message); err != nil {
			return nil, ErrInvalidBridgeMessage
		}
		return message, nil
	case "bridge.hello":
		var message contracts.BridgeHelloMessage
		if err := decodeNormalizedBridgeMessage(normalized, &message); err != nil {
			return nil, ErrInvalidBridgeMessage
		}
		return message, nil
	case "bridge.heartbeat":
		var message contracts.BridgeHeartbeatMessage
		if err := decodeNormalizedBridgeMessage(normalized, &message); err != nil {
			return nil, ErrInvalidBridgeMessage
		}
		return message, nil
	case "agent.publish":
		var message contracts.AgentPublishMessage
		if err := decodeNormalizedBridgeMessage(normalized, &message); err != nil {
			return nil, ErrInvalidBridgeMessage
		}
		return message, nil
	case "agent.status":
		var message contracts.AgentStatusMessage
		if err := decodeNormalizedBridgeMessage(normalized, &message); err != nil {
			return nil, ErrInvalidBridgeMessage
		}
		return message, nil
	case "agent.provision.requested":
		var message contracts.AgentProvisionRequestedMessage
		if err := decodeNormalizedBridgeMessage(normalized, &message); err != nil {
			return nil, ErrInvalidBridgeMessage
		}
		return message, nil
	case "agent.provision.result":
		var message contracts.AgentProvisionResultMessage
		if err := decodeNormalizedBridgeMessage(normalized, &message); err != nil {
			return nil, ErrInvalidBridgeMessage
		}
		return message, nil
	case "run.requested":
		var message contracts.RunRequestedMessage
		if err := decodeNormalizedBridgeMessage(normalized, &message); err != nil {
			return nil, ErrInvalidBridgeMessage
		}
		return message, nil
	case "run.accepted":
		var message contracts.RunAcceptedMessage
		if err := decodeNormalizedBridgeMessage(normalized, &message); err != nil {
			return nil, ErrInvalidBridgeMessage
		}
		return message, nil
	case "run.status":
		var message contracts.RunStatusMessage
		if err := decodeNormalizedBridgeMessage(normalized, &message); err != nil {
			return nil, ErrInvalidBridgeMessage
		}
		return message, nil
	case "run.reply":
		var message contracts.RunReplyMessage
		if err := decodeNormalizedBridgeMessage(normalized, &message); err != nil {
			return nil, ErrInvalidBridgeMessage
		}
		return message, nil
	case "run.cancel_requested":
		var message contracts.RunCancelRequestedMessage
		if err := decodeNormalizedBridgeMessage(normalized, &message); err != nil {
			return nil, ErrInvalidBridgeMessage
		}
		return message, nil
	case "run.handoff_requested":
		var message contracts.RunHandoffRequestedMessage
		if err := decodeNormalizedBridgeMessage(normalized, &message); err != nil {
			return nil, ErrInvalidBridgeMessage
		}
		return message, nil
	default:
		return nil, ErrInvalidBridgeMessage
	}
}

func decodeNormalizedBridgeMessage(source []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(source))
	decoder.UseNumber()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return ErrInvalidBridgeMessage
	}
	return nil
}

func containsNonCanonicalProperty(value any, tree canonicalPropertyTree) bool {
	switch typed := value.(type) {
	case map[string]any:
		for property, child := range typed {
			childTree, exact := tree.Properties[property]
			if !exact {
				for canonical := range tree.Properties {
					if strings.EqualFold(property, canonical) {
						return true
					}
				}
				if tree.Additional != nil &&
					containsNonCanonicalProperty(child, *tree.Additional) {
					return true
				}
				continue
			}
			if containsNonCanonicalProperty(child, childTree) {
				return true
			}
		}
	case []any:
		if tree.Items != nil {
			for _, child := range typed {
				if containsNonCanonicalProperty(child, *tree.Items) {
					return true
				}
			}
		}
	}
	return false
}

func normalizeDeclaredNumbers(
	value any,
	tree canonicalPropertyTree,
) (any, error) {
	if tree.Integer {
		number, ok := value.(json.Number)
		if !ok {
			return value, nil
		}
		rational, ok := new(big.Rat).SetString(number.String())
		if !ok || !rational.IsInt() {
			return nil, ErrInvalidBridgeMessage
		}
		integer := rational.Num()
		maximum := big.NewInt(maxSafeJSONInteger)
		minimum := new(big.Int).Neg(maximum)
		if integer.Cmp(minimum) < 0 || integer.Cmp(maximum) > 0 {
			return nil, ErrInvalidBridgeMessage
		}
		return integer.Int64(), nil
	}
	if tree.Number {
		number, ok := value.(json.Number)
		if !ok {
			return value, nil
		}
		rational, ok := new(big.Rat).SetString(number.String())
		parsed, err := strconv.ParseFloat(number.String(), 64)
		if !ok || err != nil || math.IsInf(parsed, 0) || math.IsNaN(parsed) ||
			(parsed == 0 && rational.Sign() != 0) {
			return nil, ErrInvalidBridgeMessage
		}
		return parsed, nil
	}
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			childTree, exact := tree.Properties[key]
			if !exact {
				if tree.Additional == nil {
					continue
				}
				childTree = *tree.Additional
			}
			normalized, err := normalizeDeclaredNumbers(child, childTree)
			if err != nil {
				return nil, err
			}
			typed[key] = normalized
		}
		return typed, nil
	case []any:
		if tree.Items == nil {
			return typed, nil
		}
		for index, child := range typed {
			normalized, err := normalizeDeclaredNumbers(child, *tree.Items)
			if err != nil {
				return nil, err
			}
			typed[index] = normalized
		}
		return typed, nil
	default:
		return value, nil
	}
}

func decodeSingleJSONValue(source []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(source))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, ErrInvalidBridgeMessage
	}
	return value, nil
}

func mustCompileBridgeSchema() *jsonschema.Schema {
	document, err := decodeSingleJSONValue(bridgeSchemaSource)
	if err != nil {
		panic("generated Bridge schema is invalid JSON")
	}
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	if err := compiler.AddResource(bridgeSchemaID, document); err != nil {
		panic("generated Bridge schema cannot be registered")
	}
	schema, err := compiler.Compile(bridgeSchemaID)
	if err != nil {
		panic("generated Bridge schema cannot be compiled")
	}
	return schema
}

func mustDecodeCanonicalPropertyTrees() map[string]canonicalPropertyTree {
	var trees map[string]canonicalPropertyTree
	if err := json.Unmarshal([]byte(bridgeCanonicalPropertyTreesSource), &trees); err != nil {
		panic("generated Bridge canonical property trees are invalid JSON")
	}
	return trees
}

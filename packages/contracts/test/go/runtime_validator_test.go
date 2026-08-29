package contracts_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	contracts "convenewire.dev/contracts/generated/go"
	runtimecontracts "convenewire.dev/contracts/generated/go/runtime"
)

const bridgeRuntimeSchemaID = "https://agentroom.dev/schemas/bridge/messages.schema.json"

type runtimeFixtureSuite struct {
	Cases []struct {
		Name     string          `json:"name"`
		SchemaID string          `json:"schemaId"`
		Instance json.RawMessage `json:"instance"`
		Valid    bool            `json:"valid"`
	} `json:"cases"`
}

type rawRuntimeFixtureSuite struct {
	Cases []struct {
		Name        string `json:"name"`
		MessageType string `json:"messageType"`
		Raw         string `json:"raw"`
		RawPrefix   string `json:"rawPrefix"`
		Repeat      string `json:"repeat"`
		RepeatCount int    `json:"repeatCount"`
		NestCount   int    `json:"nestCount"`
		ArrayItem   string `json:"arrayItem"`
		ArrayCount  int    `json:"arrayCount"`
		RawSuffix   string `json:"rawSuffix"`
		Valid       bool   `json:"valid"`
	} `json:"cases"`
}

func rawRuntimeFixtureSource(fixture struct {
	Name        string `json:"name"`
	MessageType string `json:"messageType"`
	Raw         string `json:"raw"`
	RawPrefix   string `json:"rawPrefix"`
	Repeat      string `json:"repeat"`
	RepeatCount int    `json:"repeatCount"`
	NestCount   int    `json:"nestCount"`
	ArrayItem   string `json:"arrayItem"`
	ArrayCount  int    `json:"arrayCount"`
	RawSuffix   string `json:"rawSuffix"`
	Valid       bool   `json:"valid"`
}) string {
	if fixture.Raw != "" {
		return fixture.Raw
	}
	if fixture.NestCount > 0 {
		return fixture.RawPrefix + strings.Repeat("[", fixture.NestCount) +
			"null" + strings.Repeat("]", fixture.NestCount) + fixture.RawSuffix
	}
	if fixture.ArrayCount > 0 {
		items := make([]string, fixture.ArrayCount)
		for index := range items {
			items[index] = fixture.ArrayItem
		}
		return fixture.RawPrefix + strings.Join(items, ",") + fixture.RawSuffix
	}
	return fixture.RawPrefix + strings.Repeat(
		fixture.Repeat,
		fixture.RepeatCount,
	) + fixture.RawSuffix
}

func runtimeFixturePath(t *testing.T, name string) string {
	t.Helper()
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate runtime validator test")
	}
	return filepath.Join(filepath.Dir(filename), "..", "..", "fixtures", name)
}

func readRawRuntimeFixtures(t *testing.T) rawRuntimeFixtureSuite {
	t.Helper()
	source, err := os.ReadFile(runtimeFixturePath(
		t,
		"runtime-bridge-wire-cases.json",
	))
	if err != nil {
		t.Fatalf("read raw runtime fixtures: %v", err)
	}
	var suite rawRuntimeFixtureSuite
	if err := json.Unmarshal(source, &suite); err != nil {
		t.Fatalf("decode raw runtime fixtures: %v", err)
	}
	return suite
}

func validateRuntimeValue(t *testing.T, value any, want bool) {
	t.Helper()
	source, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal value: %v", err)
	}
	if got := runtimecontracts.ValidateBridgeMessage(source) == nil; got != want {
		t.Fatalf("ValidateBridgeMessage()=%t, want %t", got, want)
	}
}

func decodedBridgeMessageType(value any) string {
	switch value.(type) {
	case contracts.AgentProvisionRequestedMessage:
		return "agent.provision.requested"
	case contracts.AgentProvisionResultMessage:
		return "agent.provision.result"
	case contracts.AgentPublishMessage:
		return "agent.publish"
	case contracts.AgentStatusMessage:
		return "agent.status"
	case contracts.BridgeHeartbeatMessage:
		return "bridge.heartbeat"
	case contracts.BridgeHelloMessage:
		return "bridge.hello"
	case contracts.RunAcceptedMessage:
		return "run.accepted"
	case contracts.RunActivityMessage:
		return "run.activity"
	case contracts.RunCancelRequestedMessage:
		return "run.cancel_requested"
	case contracts.RunHandoffRequestedMessage:
		return "run.handoff_requested"
	case contracts.RunOutputDeltaMessage:
		return "run.output_delta"
	case contracts.RunReplyMessage:
		return "run.reply"
	case contracts.RunRequestedMessage:
		return "run.requested"
	case contracts.RunStatusMessage:
		return "run.status"
	default:
		return ""
	}
}

func runtimeRunReply(content string) map[string]any {
	return map[string]any{
		"protocolVersion": "1.0",
		"messageId":       "msg_runtime_validator_12345678",
		"timestamp":       "2026-08-29T00:00:00Z",
		"type":            "run.reply",
		"payload": map[string]any{
			"runId":    "run_runtime_validator_12345678",
			"traceId":  "trace_runtime_validator_12345678",
			"agentId":  "agent_runtime_validator_12345678",
			"sequence": 3,
			"content":  content,
		},
	}
}

func runtimeFailedStatus(protocolError map[string]any) map[string]any {
	message := runtimeRunReply("Completed.")
	message["type"] = "run.status"
	message["payload"] = map[string]any{
		"runId":    "run_runtime_validator_12345678",
		"traceId":  "trace_runtime_validator_12345678",
		"agentId":  "agent_runtime_validator_12345678",
		"sequence": 3,
		"status":   "failed",
		"error":    protocolError,
	}
	return message
}

func runtimeAgentPublish(name string, role string) map[string]any {
	return map[string]any{
		"protocolVersion": "1.0",
		"messageId":       "msg_runtime_validator_agent_1234",
		"timestamp":       "2026-08-29T00:00:00Z",
		"type":            "agent.publish",
		"payload": map[string]any{
			"teamId":        "team_runtime_validator_12345678",
			"agentId":       "agent_runtime_validator_12345678",
			"ownerMemberId": "member_runtime_validator_12345678",
			"deviceId":      "device_runtime_validator_12345678",
			"name":          name,
			"role":          role,
			"capabilities": map[string]any{
				"invocationMode":    "managed",
				"supportsStart":     true,
				"supportsResume":    false,
				"supportsStreaming": true,
				"supportsInterrupt": true,
				"supportsHandoff":   false,
			},
		},
	}
}

func TestRuntimeValidatorAgreesWithEveryRootBridgeFixture(t *testing.T) {
	source, err := os.ReadFile(runtimeFixturePath(t, "cases.json"))
	if err != nil {
		t.Fatalf("read fixtures: %v", err)
	}
	var suite runtimeFixtureSuite
	if err := json.Unmarshal(source, &suite); err != nil {
		t.Fatalf("decode fixtures: %v", err)
	}
	matched := 0
	for _, fixture := range suite.Cases {
		if fixture.SchemaID != bridgeRuntimeSchemaID {
			continue
		}
		matched++
		t.Run(fixture.Name, func(t *testing.T) {
			got := runtimecontracts.ValidateBridgeMessage(fixture.Instance) == nil
			if got != fixture.Valid {
				t.Fatalf("valid=%t, want %t", got, fixture.Valid)
			}
			decoded, decodeErr := runtimecontracts.DecodeBridgeMessage(fixture.Instance)
			if decodedOK := decodeErr == nil; decodedOK != fixture.Valid {
				t.Fatalf("typed decode valid=%t, want %t", decodedOK, fixture.Valid)
			}
			if fixture.Valid {
				var envelope struct {
					Type string `json:"type"`
				}
				if err := json.Unmarshal(fixture.Instance, &envelope); err != nil {
					t.Fatalf("decode fixture envelope: %v", err)
				}
				if gotType := decodedBridgeMessageType(decoded); gotType != envelope.Type {
					t.Fatalf("decoded type=%q, want %q (%T)", gotType, envelope.Type, decoded)
				}
			}
		})
	}
	if matched == 0 {
		t.Fatal("no root Bridge fixtures were exercised")
	}
}

func TestRawRuntimeDecoderAgreesWithExactNumberCorpus(t *testing.T) {
	suite := readRawRuntimeFixtures(t)
	if len(suite.Cases) == 0 {
		t.Fatal("no raw runtime fixtures were exercised")
	}
	for _, fixture := range suite.Cases {
		fixture := fixture
		t.Run(fixture.Name, func(t *testing.T) {
			source := rawRuntimeFixtureSource(fixture)
			decoded, err := runtimecontracts.DecodeBridgeMessage([]byte(source))
			if got := err == nil; got != fixture.Valid {
				t.Fatalf("DecodeBridgeMessage() valid=%t, want %t", got, fixture.Valid)
			}
			if !fixture.Valid {
				if err != runtimecontracts.ErrInvalidBridgeMessage {
					t.Fatalf("unexpected validation error: %v", err)
				}
				return
			}
			if gotType := decodedBridgeMessageType(decoded); gotType != fixture.MessageType {
				t.Fatalf("decoded type=%q, want %q (%T)", gotType, fixture.MessageType, decoded)
			}
		})
	}
}

func TestRawRuntimeDecoderNormalizesDeclaredAndRetainsOpenNumbers(t *testing.T) {
	suite := readRawRuntimeFixtures(t)
	for _, fixture := range suite.Cases {
		if !fixture.Valid {
			continue
		}
		source := rawRuntimeFixtureSource(fixture)
		decoded, err := runtimecontracts.DecodeBridgeMessage([]byte(source))
		if err != nil {
			t.Fatalf("decode %s: %v", fixture.Name, err)
		}
		switch fixture.Name {
		case "declared integer accepts exponent notation":
			if decoded.(contracts.RunReplyMessage).Payload.Sequence != 1 {
				t.Fatal("exponent integer was not normalized to int64")
			}
		case "declared integer accepts maximum safe value":
			if decoded.(contracts.RunReplyMessage).Payload.Sequence != 9007199254740991 {
				t.Fatal("maximum safe integer changed during decode")
			}
		case "error details retain deep raw numbers":
			details := decoded.(contracts.RunStatusMessage).Payload.Error.Details
			if got, ok := details["exitCode"].(json.Number); !ok || got.String() != "2" {
				t.Fatalf("exitCode=%#v, want exact json.Number(2)", details["exitCode"])
			}
			if got, ok := details["huge"].(json.Number); !ok || got.String() != "1e400" {
				t.Fatalf("huge=%#v, want exact json.Number(1e400)", details["huge"])
			}
			if got, ok := details["unsafeInteger"].(json.Number); !ok || got.String() != "9007199254740993" {
				t.Fatalf("unsafeInteger=%#v, want exact json.Number", details["unsafeInteger"])
			}
		case "deep session cursors and revisions normalize":
			status := decoded.(contracts.RunStatusMessage)
			if status.Payload.Session.ContextCursor != 1 ||
				*status.Payload.Session.ResultEvidenceRevision != 9007199254740991 {
				t.Fatalf("deep declared integers were not normalized: %#v", status.Payload.Session)
			}
		case "run request declared nested integers normalize":
			requested := decoded.(contracts.RunRequestedMessage)
			if requested.Payload.Session.ContextCursor != 1 ||
				requested.Payload.ContextMessages[0].Sequence == nil ||
				*requested.Payload.ContextMessages[0].Sequence != 1 {
				t.Fatalf("Run request integers were not normalized: %#v", requested.Payload)
			}
		case "escaped Unicode surrogate pair decodes without drift":
			reply := decoded.(contracts.RunReplyMessage)
			if reply.Payload.Content != "😀" {
				t.Fatalf("escaped surrogate pair content=%q, want emoji", reply.Payload.Content)
			}
		}
	}
}

func TestRuntimeValidatorClosesEnvelopeAndRetainsPayloadExtensions(t *testing.T) {
	message := runtimeRunReply("Completed.")
	validateRuntimeValue(t, message, true)
	message["unexpected"] = true
	validateRuntimeValue(t, message, false)
	delete(message, "unexpected")
	delete(message, "messageId")
	validateRuntimeValue(t, message, false)
	message["messageId"] = "msg_runtime_validator_12345678"
	delete(message, "timestamp")
	validateRuntimeValue(t, message, false)
	message["timestamp"] = "2026-08-29T00:00:00Z"
	message["payload"].(map[string]any)["futureOptionalAssessmentHint"] = true
	validateRuntimeValue(t, message, true)
}

func TestRuntimeValidatorEnforcesReplyAndErrorBounds(t *testing.T) {
	validateRuntimeValue(t, runtimeRunReply(strings.Repeat("x", 20_000)), true)
	validateRuntimeValue(t, runtimeRunReply(strings.Repeat("x", 20_001)), false)
	validateRuntimeValue(t, runtimeRunReply(strings.Repeat("😀", 20_000)), true)
	validateRuntimeValue(t, runtimeRunReply(strings.Repeat("😀", 20_001)), false)

	maximumError := map[string]any{
		"code":      strings.Repeat("A", 64),
		"message":   strings.Repeat("m", 512),
		"retryable": false,
	}
	validateRuntimeValue(t, runtimeFailedStatus(maximumError), true)
	tooLongCode := map[string]any{
		"code":      strings.Repeat("A", 65),
		"message":   strings.Repeat("m", 512),
		"retryable": false,
	}
	validateRuntimeValue(t, runtimeFailedStatus(tooLongCode), false)
	tooLongMessage := map[string]any{
		"code":      strings.Repeat("A", 64),
		"message":   strings.Repeat("m", 513),
		"retryable": false,
	}
	validateRuntimeValue(t, runtimeFailedStatus(tooLongMessage), false)
	unknownErrorField := map[string]any{
		"code":          strings.Repeat("A", 64),
		"message":       strings.Repeat("m", 512),
		"retryable":     false,
		"internalStack": "must not cross the boundary",
	}
	validateRuntimeValue(t, runtimeFailedStatus(unknownErrorField), false)
}

func TestRuntimeValidatorAcceptsOnlyTypedGoCompatibleUTCTimestamps(t *testing.T) {
	tests := []struct {
		timestamp string
		valid     bool
	}{
		{timestamp: "2026-08-29T00:00:00Z", valid: true},
		{timestamp: "2026-08-29T00:00:00.1Z", valid: true},
		{timestamp: "2026-08-29T00:00:00.123456789Z", valid: true},
		{timestamp: "2026-08-29t00:00:00Z", valid: false},
		{timestamp: "2026-08-29T23:59:60Z", valid: false},
		{timestamp: "2026-08-29T00:00:00.1234567890Z", valid: false},
	}
	for _, test := range tests {
		t.Run(test.timestamp, func(t *testing.T) {
			message := runtimeRunReply("Completed.")
			message["timestamp"] = test.timestamp
			source, err := json.Marshal(message)
			if err != nil {
				t.Fatalf("marshal value: %v", err)
			}
			if got := runtimecontracts.ValidateBridgeMessage(source) == nil; got != test.valid {
				t.Fatalf("ValidateBridgeMessage()=%t, want %t", got, test.valid)
			}
			var typed contracts.RunReplyMessage
			typedErr := json.Unmarshal(source, &typed)
			if test.valid && typedErr != nil {
				t.Fatalf("schema-valid timestamp failed typed unmarshal: %v", typedErr)
			}
		})
	}
}

func TestRuntimeValidatorAgentPublicationBoundsUseUnicodeCodePoints(t *testing.T) {
	validateRuntimeValue(t, runtimeAgentPublish(
		strings.Repeat("😀", 80),
		strings.Repeat("🛠", 80),
	), true)
	validateRuntimeValue(t, runtimeAgentPublish("n", strings.Repeat("r", 81)), false)
	validateRuntimeValue(t, runtimeAgentPublish("n", strings.Repeat("🛠", 81)), false)
}

func TestRuntimeValidatorReturnsOnlyTheStableErrorCategory(t *testing.T) {
	errorText := runtimecontracts.ValidateBridgeMessage(
		[]byte(`{"secret":"do-not-echo"}`),
	).Error()
	if errorText != runtimecontracts.ErrInvalidBridgeMessage.Error() ||
		strings.Contains(errorText, "do-not-echo") {
		t.Fatalf("unsafe validation error: %q", errorText)
	}
}

func TestRuntimeValidatorRejectsInvalidUTF8(t *testing.T) {
	if err := runtimecontracts.ValidateBridgeMessage([]byte{0xff});
		err != runtimecontracts.ErrInvalidBridgeMessage {
		t.Fatalf("invalid UTF-8 error=%v", err)
	}
}

func TestRuntimeDecoderRejectsUTF8BOMBeforeJSONMaterialization(t *testing.T) {
	source := append(
		[]byte{0xef, 0xbb, 0xbf},
		[]byte(`{"protocolVersion":"1.0","messageId":"msg_runtime_bom_12345678","timestamp":"2026-08-29T00:00:00Z","type":"run.reply","payload":{"runId":"run_runtime_bom_12345678","traceId":"trace_runtime_bom_12345678","agentId":"agent_runtime_bom_12345678","sequence":1,"content":"ok"}}`)...,
	)
	if _, err := runtimecontracts.DecodeBridgeMessage(source);
		err != runtimecontracts.ErrInvalidBridgeMessage {
		t.Fatalf("UTF-8 BOM error=%v", err)
	}
}

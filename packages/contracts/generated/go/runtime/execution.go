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
		"executionGrant", "repositoryOperation", "repositoryReceipt", "executionCheckpoint", "verificationReceipt"} {
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
	if err != nil || schema.Validate(value) != nil {
		return nil, ErrInvalidExecutionJSON
	}
	var output bytes.Buffer
	if err := appendExecutionJSON(&output, value); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
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

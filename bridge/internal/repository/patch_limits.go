package repository

import (
	"bufio"
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"io"
	"strconv"
	"strings"
)

// Reject compressed binary expansion before invoking git apply. In particular
// a delta hunk's declared length is its instruction size, NOT its output size.
// This is a resource preflight, not a substitute for Git's patch validation.
func patchExpansionBound(patch []byte, limit int64) (int64, error) {
	bound := int64(len(patch))
	if bound > limit {
		return 0, ErrLimit
	}
	scanner := bufio.NewScanner(bytes.NewReader(patch))
	scanner.Buffer(make([]byte, 4096), 64<<20)
	for scanner.Scan() {
		line := scanner.Text()
		kind, length, ok := strings.Cut(line, " ")
		if !ok || (kind != "literal" && kind != "delta") {
			continue
		}
		expected, err := strconv.ParseInt(length, 10, 64)
		if err != nil || expected < 0 {
			return 0, ErrInvalid
		}
		if expected > limit-bound {
			return 0, ErrLimit
		}
		var compressed []byte
		for scanner.Scan() {
			line := scanner.Bytes()
			if len(line) == 0 {
				break
			}
			decoded, err := decodePatchLine(line)
			if err != nil {
				return 0, err
			}
			compressed = append(compressed, decoded...)
		}
		reader, err := zlib.NewReader(bytes.NewReader(compressed))
		if err != nil {
			return 0, ErrInvalid
		}
		decoded, readErr := io.ReadAll(io.LimitReader(reader, expected+1))
		closeErr := reader.Close()
		if readErr != nil || closeErr != nil || int64(len(decoded)) != expected {
			return 0, ErrInvalid
		}
		expansion := expected
		if kind == "delta" {
			base, used := binary.Uvarint(decoded)
			if used <= 0 || base > uint64(limit) {
				return 0, ErrLimit
			}
			target, used := binary.Uvarint(decoded[used:])
			if used <= 0 || target > uint64(limit-bound) {
				return 0, ErrLimit
			}
			if int64(target) > expansion {
				expansion = int64(target)
			}
		}
		if expansion > limit-bound {
			return 0, ErrLimit
		}
		bound += expansion
	}
	if scanner.Err() != nil {
		return 0, ErrInvalid
	}
	return bound, nil
}

const patchAlphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~"

func decodePatchLine(line []byte) ([]byte, error) {
	if len(line) < 6 {
		return nil, ErrInvalid
	}
	var count int
	switch {
	case line[0] >= 'A' && line[0] <= 'Z':
		count = int(line[0]-'A') + 1
	case line[0] >= 'a' && line[0] <= 'z':
		count = int(line[0]-'a') + 27
	default:
		return nil, ErrInvalid
	}
	if len(line) != 1+((count+3)/4)*5 {
		return nil, ErrInvalid
	}
	decoded := make([]byte, 0, ((count+3)/4)*4)
	for offset := 1; offset < len(line); offset += 5 {
		var value uint64
		for _, char := range line[offset : offset+5] {
			digit := strings.IndexByte(patchAlphabet, char)
			if digit < 0 {
				return nil, ErrInvalid
			}
			value = value*85 + uint64(digit)
		}
		if value > 0xffffffff {
			return nil, ErrInvalid
		}
		decoded = append(decoded, byte(value>>24), byte(value>>16), byte(value>>8), byte(value))
	}
	return decoded[:count], nil
}

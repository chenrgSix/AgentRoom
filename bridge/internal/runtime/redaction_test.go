package runtime

import (
	"strings"
	"testing"
)

func TestRedactSensitiveTextRemovesCommonCredentials(t *testing.T) {
	source := "Bearer abcdefghijklmnop secret=very-sensitive-value sk-1234567890abcdefghijkl"
	redacted := RedactSensitiveText(source)
	if strings.Contains(redacted, "abcdefghijklmnop") || strings.Contains(redacted, "very-sensitive") || strings.Contains(redacted, "sk-") {
		t.Fatalf("secret remained in redacted output: %q", redacted)
	}
}

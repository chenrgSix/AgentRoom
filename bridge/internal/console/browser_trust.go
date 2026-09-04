package console

import (
	"crypto/sha1" // #nosec G505 -- Windows certificate-store lookup uses the certificate thumbprint, not SHA-1 as a trust primitive.
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"convenewire.dev/bridge/internal/pairing"
)

type BrowserTrustSetupView struct {
	CACertificateSHA256             string `json:"caCertificateSha256"`
	WindowsPowerShellCommand        string `json:"windowsPowerShellCommand"`
	WindowsRemovalPowerShellCommand string `json:"windowsRemovalPowerShellCommand"`
}

func browserTrustSetupView(
	credential pairing.Credential,
	now time.Time,
) *BrowserTrustSetupView {
	if credential.ScopedPrivateTrust == nil {
		return nil
	}
	certificate, err := pairing.ValidatedScopedPrivateCACertificate(
		*credential.ScopedPrivateTrust,
		credential.ServerURL,
		now,
	)
	if err != nil {
		return nil
	}

	digest := sha256.Sum256(certificate.Raw)
	fingerprint := hex.EncodeToString(digest[:])
	thumbprint := sha1.Sum(certificate.Raw) // #nosec G401 -- see import comment; this is a Windows store identifier only.
	certificateBase64 := base64.StdEncoding.EncodeToString(certificate.Raw)

	install := fmt.Sprintf(
		"$ErrorActionPreference='Stop'; $expected='%s'; $raw=[Convert]::FromBase64String('%s'); $sha=[Security.Cryptography.SHA256]::Create(); try { $actual=([BitConverter]::ToString($sha.ComputeHash($raw))).Replace('-','').ToLowerInvariant(); if ($actual -ne $expected) { throw 'ConveneWire CA SHA-256 mismatch' }; $tmp=[IO.Path]::Combine([IO.Path]::GetTempPath(),('convenewire-browser-ca-'+[Guid]::NewGuid().ToString('N')+'.cer')); try { [IO.File]::WriteAllBytes($tmp,$raw); $fileActual=(Get-FileHash -LiteralPath $tmp -Algorithm SHA256).Hash.ToLowerInvariant(); if ($fileActual -ne $expected) { throw 'ConveneWire CA file SHA-256 mismatch' }; $certutil=[IO.Path]::Combine([Environment]::SystemDirectory,'certutil.exe'); & $certutil -user -f -addstore Root $tmp; if ($LASTEXITCODE -ne 0) { throw 'Windows rejected the ConveneWire CA installation' }; Write-Host 'ConveneWire CA installed for the current Windows user.' } finally { if ($tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue } } } finally { $sha.Dispose() }",
		fingerprint,
		certificateBase64,
	)
	remove := fmt.Sprintf(
		"$ErrorActionPreference='Stop'; $certutil=[IO.Path]::Combine([Environment]::SystemDirectory,'certutil.exe'); & $certutil -user -delstore Root '%s'; if ($LASTEXITCODE -ne 0) { throw 'Windows could not remove the ConveneWire CA' }; Write-Host 'ConveneWire CA removed from the current Windows user.'",
		strings.ToUpper(hex.EncodeToString(thumbprint[:])),
	)

	return &BrowserTrustSetupView{
		CACertificateSHA256:             fingerprint,
		WindowsPowerShellCommand:        install,
		WindowsRemovalPowerShellCommand: remove,
	}
}

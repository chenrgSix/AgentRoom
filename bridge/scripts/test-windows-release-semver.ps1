[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "windows-release-semver.ps1")

function Assert-AcceptedUpgrade {
  param([string]$Previous, [string]$Candidate)
  $output = @(Assert-ConveneWireReleaseUpgrade `
      -PreviousReleaseTag $Previous `
      -CandidateReleaseTag $Candidate)
  if ($output.Count -ne 0) {
    throw "Accepted upgrade emitted unexpected pipeline output"
  }
}

function Assert-RejectedUpgrade {
  param(
    [string]$Previous,
    [string]$Candidate,
    [string]$ExpectedMessage
  )
  try {
    Assert-ConveneWireReleaseUpgrade `
      -PreviousReleaseTag $Previous `
      -CandidateReleaseTag $Candidate
  }
  catch {
    if ($_.Exception.Message -notmatch $ExpectedMessage) {
      throw "Upgrade pair failed for the wrong reason: $($_.Exception.Message)"
    }
    return
  }
  throw "Expected upgrade pair to be rejected: $Previous -> $Candidate"
}

function Assert-VersionPrecedes {
  param([string]$Earlier, [string]$Later)
  $earlierVersion = ConvertTo-ConveneWireSemanticVersion $Earlier
  $laterVersion = ConvertTo-ConveneWireSemanticVersion $Later
  if ((Compare-ConveneWireSemanticVersion $earlierVersion $laterVersion) -ge 0) {
    throw "Expected SemVer precedence was not preserved: $Earlier < $Later"
  }
}

Assert-AcceptedUpgrade "v0.4.0" "v0.4.1-rc.1"
Assert-AcceptedUpgrade "v0.4.0" "v999.0.0-ci"
Assert-AcceptedUpgrade "v1.0.0" "v184467440737095516160.0.0"

$precedence = @(
  "v1.0.0-alpha",
  "v1.0.0-alpha.1",
  "v1.0.0-alpha.beta",
  "v1.0.0-beta",
  "v1.0.0-beta.2",
  "v1.0.0-beta.11",
  "v1.0.0-rc.1",
  "v1.0.0"
)
for ($index = 0; $index -lt $precedence.Count - 1; $index++) {
  Assert-VersionPrecedes $precedence[$index] $precedence[$index + 1]
}

Assert-RejectedUpgrade "v0.4.0" "v0.3.99" "greater SemVer precedence"
Assert-RejectedUpgrade "v0.4.0" "v0.4.0-qa.1" "greater SemVer precedence"
Assert-RejectedUpgrade "v0.4.0" "v0.4.0" "greater SemVer precedence"
Assert-RejectedUpgrade "v0.4.0-rc.1" "v0.4.1" "stable SemVer"
Assert-RejectedUpgrade "v0.4.0" "v0.4.01" "canonical SemVer"
Assert-RejectedUpgrade "v0.4.0" "v0.4.1-01" "leading zeroes"
Assert-RejectedUpgrade "v0.4.0" "v0.4.1+build.7" "canonical SemVer"
Assert-RejectedUpgrade "v0.4.0" "v0.4.1`n" "canonical SemVer"

Write-Output "Verified Windows Release SemVer upgrade ordering"

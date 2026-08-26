[CmdletBinding()]
param(
  [string]$ReleaseTag = $env:RELEASE_TAG,
  [string]$GoArch = $env:GOARCH,
  [string]$OutputDir = $env:OUTPUT_DIR
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$bridgeRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$repositoryRoot = Split-Path $bridgeRoot -Parent
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $OutputDir = Join-Path $bridgeRoot "dist"
}
if ([string]::IsNullOrWhiteSpace($ReleaseTag)) {
  throw "RELEASE_TAG is required"
}
if ([string]::IsNullOrWhiteSpace($GoArch)) {
  throw "GOARCH is required"
}
if (-not $ReleaseTag.StartsWith("v")) {
  throw "Release tag must start with v"
}

$version = $ReleaseTag.Substring(1)
if ($version -notmatch '^[0-9A-Za-z._-]+$') {
  throw "Release tag must contain only letters, numbers, dots, underscores, and hyphens"
}
if ($version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z._-]+)?$') {
  throw "Desktop release tag must start with a three-part semantic version"
}
if ($GoArch -ne "amd64") {
  throw "Unsupported Windows desktop architecture: $GoArch"
}

$hostOS = (& go env GOHOSTOS).Trim()
$hostArch = (& go env GOHOSTARCH).Trim()
if ($LASTEXITCODE -ne 0) {
  throw "Unable to determine the native Go host"
}
if ("$hostOS/$hostArch" -ne "windows/$GoArch") {
  throw "Desktop package requires a native windows/$GoArch builder; found $hostOS/$hostArch"
}

$package = "agentroom-bridge-desktop_${version}_windows_${GoArch}"
$staging = Join-Path $OutputDir $package
$binary = Join-Path $staging "AgentRoom Bridge.exe"
$archive = Join-Path $OutputDir "${package}.zip"
if ((Test-Path -LiteralPath $staging) -or (Test-Path -LiteralPath $archive)) {
  throw "Desktop package output already exists: $package"
}

New-Item -ItemType Directory -Path $staging -Force | Out-Null
$previousCGO = $env:CGO_ENABLED
$previousGOOS = $env:GOOS
$previousGOARCH = $env:GOARCH
try {
  $env:CGO_ENABLED = "0"
  $env:GOOS = "windows"
  $env:GOARCH = $GoArch
  Push-Location $bridgeRoot
  try {
    $buildArguments = @(
      "build",
      "-tags=desktop,production",
      "-trimpath",
      "-ldflags=-s -w -H=windowsgui -X=main.version=$ReleaseTag",
      "-o", $binary,
      "./cmd/agentroom-bridge-desktop"
    )
    & go @buildArguments
    if ($LASTEXITCODE -ne 0) {
      throw "Windows Desktop build failed"
    }
  }
  finally {
    Pop-Location
  }
}
finally {
  $env:CGO_ENABLED = $previousCGO
  $env:GOOS = $previousGOOS
  $env:GOARCH = $previousGOARCH
}

Copy-Item (Join-Path $bridgeRoot "README.md") (Join-Path $staging "README.md")
Copy-Item (Join-Path $repositoryRoot "LICENSE") (Join-Path $staging "LICENSE")
Copy-Item (Join-Path $repositoryRoot "NOTICE") (Join-Path $staging "NOTICE")
Copy-Item (Join-Path $repositoryRoot "COMMERCIAL-LICENSE.md") (Join-Path $staging "COMMERCIAL-LICENSE.md")

$binaryBytes = [IO.File]::ReadAllBytes($binary)
if ($binaryBytes.Length -lt 64 -or $binaryBytes[0] -ne 0x4d -or $binaryBytes[1] -ne 0x5a) {
  throw "Built desktop Bridge is not a valid Windows PE executable"
}
$peOffset = [BitConverter]::ToInt32($binaryBytes, 0x3c)
if ($peOffset -lt 0 -or $peOffset + 6 -gt $binaryBytes.Length -or
    $binaryBytes[$peOffset] -ne 0x50 -or $binaryBytes[$peOffset + 1] -ne 0x45 -or
    $binaryBytes[$peOffset + 2] -ne 0 -or $binaryBytes[$peOffset + 3] -ne 0) {
  throw "Built desktop Bridge has an invalid PE header"
}
$machine = [BitConverter]::ToUInt16($binaryBytes, $peOffset + 4)
if ($machine -ne 0x8664) {
  throw ("Built desktop Bridge has unexpected PE machine type 0x{0:x4}" -f $machine)
}

$binaryText = [Text.Encoding]::ASCII.GetString($binaryBytes)
if (-not $binaryText.Contains($ReleaseTag)) {
  throw "Built desktop Bridge does not contain the injected version $ReleaseTag"
}

Compress-Archive -LiteralPath $staging -DestinationPath $archive -CompressionLevel Optimal
if (-not (Test-Path -LiteralPath $archive) -or (Get-Item -LiteralPath $archive).Length -eq 0) {
  throw "Windows Desktop archive was not created"
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
  $members = @($zip.Entries | ForEach-Object { $_.FullName.Replace("\", "/") })
  foreach ($member in $members) {
    if ($member.StartsWith("/") -or $member -match '(^|/)\.\.(/|$)') {
      throw "Windows Desktop archive contains an unsafe path: $member"
    }
  }
  $requiredMembers = @(
    "$package/AgentRoom Bridge.exe",
    "$package/README.md",
    "$package/LICENSE",
    "$package/NOTICE",
    "$package/COMMERCIAL-LICENSE.md"
  )
  foreach ($requiredMember in $requiredMembers) {
    if ($members -notcontains $requiredMember) {
      throw "Windows Desktop archive is missing $requiredMember"
    }
  }
}
finally {
  $zip.Dispose()
}
Write-Output $archive

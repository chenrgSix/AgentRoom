[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,
  [Parameter(Mandatory = $true)]
  [string]$ReleaseTag,
  [Parameter(Mandatory = $true)]
  [string]$CandidateArchivePath,
  [Parameter(Mandatory = $true)]
  [string]$CandidateExecutablePath,
  [Parameter(Mandatory = $true)]
  [string]$PreviousInstallerPath,
  [Parameter(Mandatory = $true)]
  [string]$PreviousReleaseTag
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "windows-release-semver.ps1")
Assert-ConveneWireReleaseUpgrade `
  -PreviousReleaseTag $PreviousReleaseTag `
  -CandidateReleaseTag $ReleaseTag
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$candidateArchive = (Resolve-Path -LiteralPath $CandidateArchivePath).Path
$candidateExecutable = (Resolve-Path -LiteralPath $CandidateExecutablePath).Path
$previousInstaller = (Resolve-Path -LiteralPath $PreviousInstallerPath).Path
if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -eq
    (Get-FileHash -LiteralPath $previousInstaller -Algorithm SHA256).Hash) {
  throw "Candidate and previous stable installers must be different artifacts"
}
$hostOS = (& go env GOHOSTOS).Trim()
if ($LASTEXITCODE -ne 0 -or $hostOS -ne "windows") {
  throw "Installer verification requires a native Windows host"
}

$verificationRoot = Join-Path ([IO.Path]::GetTempPath()) ("convenewire-installer-" + [guid]::NewGuid().ToString("N"))
$installDir = Join-Path $env:LOCALAPPDATA "Programs\ConveneWire Bridge"
$installLog = Join-Path $verificationRoot "previous-install.log"
$upgradeLog = Join-Path $verificationRoot "upgrade.log"
$uninstallLog = Join-Path $verificationRoot "uninstall.log"
$configDir = Join-Path $env:APPDATA "agentroom"
$statePaths = @(
  (Join-Path $configDir "bridge.json"),
  (Join-Path $configDir "agent-identities.json"),
  (Join-Path $configDir "inbox\run_installer_upgrade_fixture.json")
)
$inboxDirectory = Join-Path $configDir "inbox"
$inboxExisted = Test-Path -LiteralPath $inboxDirectory
$stateDigests = @{}
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{2FA4C87B-E4E4-4929-B229-8F2B13DB1EF6}_is1"
$startMenuLink = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\ConveneWire Bridge\ConveneWire Bridge.lnk"
$protocolKey = "HKCU:\Software\Classes\convenewire"
$legacyProtocolKey = "HKCU:\Software\Classes\agentroom"

function Get-SafeZipExecutableSHA256 {
  param(
    [string]$ArchivePath,
    [string]$ExpectedMember
  )

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
  try {
    $seen = [Collections.Generic.HashSet[string]]::new(
      [StringComparer]::Ordinal
    )
    $matches = @()
    foreach ($entry in $zip.Entries) {
      $member = $entry.FullName
      $pathWithoutTrailingSlash = $member.TrimEnd('/')
      $segments = @($pathWithoutTrailingSlash.Split('/'))
      if ([string]::IsNullOrWhiteSpace($member) -or
          $member.Contains("\") -or $member.Contains([char]0) -or
          $member.StartsWith("/") -or
          $member -match '^[A-Za-z]:' -or
          [string]::IsNullOrWhiteSpace($pathWithoutTrailingSlash) -or
          @($segments | Where-Object {
            [string]::IsNullOrEmpty($_) -or $_ -eq '.' -or $_ -eq '..'
          }).Count -gt 0 -or
          -not $seen.Add($member)) {
        throw "Candidate archive contains an unsafe or duplicate path: $member"
      }
      $unixType = ($entry.ExternalAttributes -shr 16) -band 0xF000
      if ($unixType -eq 0xA000) {
        throw "Candidate archive contains a symbolic-link path: $member"
      }
      if ($member -eq $ExpectedMember) {
        $matches += $entry
      }
    }
    if ($matches.Count -ne 1 -or $matches[0].Length -lt 1) {
      throw "Candidate archive must contain exactly one non-empty $ExpectedMember"
    }
    $stream = $matches[0].Open()
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
      return [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace("-", "")
    }
    finally {
      $sha256.Dispose()
      $stream.Dispose()
    }
  }
  finally {
    $zip.Dispose()
  }
}

$candidateVersion = $ReleaseTag.Substring(1)
$candidatePackage = "convenewire-bridge-desktop_${candidateVersion}_windows_amd64"
if ([IO.Path]::GetFileName($candidateArchive) -ne "${candidatePackage}.zip" -or
    [IO.Path]::GetFileName($candidateExecutable) -ne "ConveneWire Bridge.exe" -or
    [IO.Path]::GetFullPath((Split-Path $candidateExecutable -Parent)) -ne
      [IO.Path]::GetFullPath((Join-Path (Split-Path $candidateArchive -Parent) $candidatePackage))) {
  throw "Candidate archive or staged executable has an unexpected name"
}
$candidateExecutableSHA256 =
  (Get-FileHash -LiteralPath $candidateExecutable -Algorithm SHA256).Hash
$archiveExecutableSHA256 = Get-SafeZipExecutableSHA256 `
  $candidateArchive "$candidatePackage/ConveneWire Bridge.exe"
if ($archiveExecutableSHA256 -ne $candidateExecutableSHA256) {
  throw "Candidate ZIP executable differs from the staged executable"
}

function Invoke-CheckedProcess {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$Description,
    [string]$LogPath
  )
  $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    if (Test-Path -LiteralPath $LogPath) {
      Get-Content -LiteralPath $LogPath | Write-Output
    }
    throw "$Description failed with exit code $($process.ExitCode)"
  }
}

function Assert-InstalledPayload {
  param(
    [string]$ExpectedReleaseTag,
    [string]$ExpectedExecutableSHA256 = ""
  )

  $expectedVersion = $ExpectedReleaseTag.Substring(1)
  $required = @(
    "ConveneWire Bridge.exe",
    "README.md",
    "LICENSE",
    "NOTICE",
    "COMMERCIAL-LICENSE.md",
    "TRADEMARKS.md",
    "unins000.exe"
  )
  foreach ($filename in $required) {
    $path = Join-Path $installDir $filename
    if (-not (Test-Path -LiteralPath $path) -or (Get-Item -LiteralPath $path).Length -eq 0) {
      throw "Installed payload is missing $filename"
    }
  }
  $binaryText = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes((Join-Path $installDir "ConveneWire Bridge.exe")))
  if (-not $binaryText.Contains($ExpectedReleaseTag)) {
    throw "Installed Bridge does not contain $ExpectedReleaseTag"
  }
  if (-not [string]::IsNullOrWhiteSpace($ExpectedExecutableSHA256)) {
    $installedDigest = (Get-FileHash `
      -LiteralPath (Join-Path $installDir "ConveneWire Bridge.exe") `
      -Algorithm SHA256).Hash
    if ($installedDigest -ne $ExpectedExecutableSHA256) {
      throw "Installed candidate executable differs from staging and ZIP"
    }
  }
  if (-not (Test-Path -LiteralPath $startMenuLink)) {
    throw "Installer did not create the current-user Start menu shortcut"
  }
  if (-not (Test-Path -LiteralPath $uninstallKey)) {
    throw "Installer did not register a current-user uninstaller"
  }
  if (-not (Test-Path -LiteralPath $protocolKey)) {
    throw "Installer did not register the convenewire Device pairing protocol"
  }
  if (-not (Test-Path -LiteralPath $legacyProtocolKey)) {
    throw "Installer did not preserve the legacy agentroom Device pairing protocol"
  }
  $protocol = Get-ItemProperty -LiteralPath $protocolKey
  if ($protocol.'URL Protocol' -ne '') {
    throw "convenewire protocol registration is missing the URL Protocol marker"
  }
  $protocolCommand = (Get-Item -LiteralPath (Join-Path $protocolKey "shell\open\command")).GetValue("")
  if (-not $protocolCommand.Contains('ConveneWire Bridge.exe') -or -not $protocolCommand.Contains('%1')) {
    throw "convenewire protocol command does not pass the pairing link to Bridge"
  }
  $legacyProtocol = Get-ItemProperty -LiteralPath $legacyProtocolKey
  if ($legacyProtocol.'URL Protocol' -ne '') {
    throw "agentroom protocol registration is missing the URL Protocol marker"
  }
  $legacyProtocolCommand = (Get-Item -LiteralPath (Join-Path $legacyProtocolKey "shell\open\command")).GetValue("")
  if (-not $legacyProtocolCommand.Contains('ConveneWire Bridge.exe') -or -not $legacyProtocolCommand.Contains('%1')) {
    throw "agentroom protocol command does not pass the pairing link to Bridge"
  }
  $registration = Get-ItemProperty -LiteralPath $uninstallKey
  if ($registration.DisplayName -ne "ConveneWire Bridge" -or
      $registration.DisplayVersion -ne $expectedVersion) {
    throw ("Installed application registration has unexpected name or version: " +
      "DisplayName='$($registration.DisplayName)', DisplayVersion='$($registration.DisplayVersion)'")
  }
}

function Install-OwnerStateFixture {
  New-Item -ItemType Directory -Path $inboxDirectory -Force | Out-Null
  $state = @{}
  $state[$statePaths[0]] =
    '{"schemaVersion":2,"serverUrl":"https://fixture.invalid","dataDir":"owner-state-fixture","agents":[]}'
  $state[$statePaths[1]] = '{"agent_fixture":"stable-owner-identity"}'
  $state[$statePaths[2]] =
    '{"runId":"run_installer_upgrade_fixture","state":"accepted","sequence":1}'
  foreach ($entry in $state.GetEnumerator()) {
    Set-Content -LiteralPath $entry.Key -Value $entry.Value -NoNewline
    $script:stateDigests[$entry.Key] =
      (Get-FileHash -LiteralPath $entry.Key -Algorithm SHA256).Hash
  }
}

function Assert-OwnerStateFixture {
  foreach ($path in $statePaths) {
    if (-not (Test-Path -LiteralPath $path)) {
      throw "Installer lifecycle removed owner state: $path"
    }
    $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
    if ($actual -ne $stateDigests[$path]) {
      throw "Installer lifecycle changed owner state: $path"
    }
  }
}

foreach ($path in $statePaths) {
  if (Test-Path -LiteralPath $path) {
    throw "Installer verification refuses to replace existing owner state: $path"
  }
}
if (Test-Path -LiteralPath $installDir) {
  throw "Installer verification refuses to replace an existing installation: $installDir"
}
if ((Test-Path -LiteralPath $uninstallKey) -or (Test-Path -LiteralPath $startMenuLink) -or
    (Test-Path -LiteralPath $protocolKey) -or (Test-Path -LiteralPath $legacyProtocolKey)) {
  throw "Installer verification refuses to replace existing Windows registration or shortcuts"
}

New-Item -ItemType Directory -Path $verificationRoot -Force | Out-Null
New-Item -ItemType Directory -Path $configDir -Force | Out-Null
try {
  $installArguments = @(
    "/VERYSILENT",
    "/SUPPRESSMSGBOXES",
    "/NORESTART",
    "/LOG=`"$installLog`""
  )
  Invoke-CheckedProcess $previousInstaller $installArguments "Previous stable installer run" $installLog
  Assert-InstalledPayload $PreviousReleaseTag
  Install-OwnerStateFixture
  Assert-OwnerStateFixture

  $upgradeArguments = @(
    "/VERYSILENT",
    "/SUPPRESSMSGBOXES",
    "/NORESTART",
    "/LOG=`"$upgradeLog`""
  )
  Invoke-CheckedProcess $installer $upgradeArguments "Installer upgrade run" $upgradeLog
  Assert-InstalledPayload $ReleaseTag $candidateExecutableSHA256
  Assert-OwnerStateFixture

  $uninstaller = Join-Path $installDir "unins000.exe"
  $uninstallArguments = @(
    "/VERYSILENT",
    "/SUPPRESSMSGBOXES",
    "/NORESTART",
    "/LOG=`"$uninstallLog`""
  )
  Invoke-CheckedProcess $uninstaller $uninstallArguments "Installer uninstall run" $uninstallLog
  if (Test-Path -LiteralPath (Join-Path $installDir "ConveneWire Bridge.exe")) {
    throw "Uninstaller left the managed Bridge executable behind"
  }
  if (Test-Path -LiteralPath $startMenuLink) {
    throw "Uninstaller left the managed Start menu shortcut behind"
  }
  if (Test-Path -LiteralPath $uninstallKey) {
    throw "Uninstaller left its current-user registration behind"
  }
  if (Test-Path -LiteralPath $protocolKey) {
    throw "Uninstaller left the convenewire protocol registration behind"
  }
  if (Test-Path -LiteralPath $legacyProtocolKey) {
    throw "Uninstaller left the legacy agentroom protocol registration behind"
  }
  Assert-OwnerStateFixture
}
finally {
  foreach ($path in $statePaths) {
    if (Test-Path -LiteralPath $path) {
      Remove-Item -LiteralPath $path -Force
    }
  }
  if (-not $inboxExisted -and (Test-Path -LiteralPath $inboxDirectory) -and
      (@(Get-ChildItem `
          -LiteralPath $inboxDirectory `
          -Force `
          -ErrorAction Stop)).Count -eq 0) {
    Remove-Item -LiteralPath $inboxDirectory -Force
  }
  if (Test-Path -LiteralPath $verificationRoot) {
    Remove-Item -LiteralPath $verificationRoot -Recurse -Force
  }
}

Write-Output ("Verified previous stable $PreviousReleaseTag to candidate " +
  "$ReleaseTag upgrade, uninstall, and owner-state preservation for $installer")

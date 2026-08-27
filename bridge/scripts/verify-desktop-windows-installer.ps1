[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,
  [Parameter(Mandatory = $true)]
  [string]$ReleaseTag
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not $ReleaseTag.StartsWith("v")) {
  throw "Release tag must start with v"
}
$version = $ReleaseTag.Substring(1)
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$hostOS = (& go env GOHOSTOS).Trim()
if ($LASTEXITCODE -ne 0 -or $hostOS -ne "windows") {
  throw "Installer verification requires a native Windows host"
}

$verificationRoot = Join-Path ([IO.Path]::GetTempPath()) ("agentroom-installer-" + [guid]::NewGuid().ToString("N"))
$installDir = Join-Path $verificationRoot "AgentRoom Bridge"
$installLog = Join-Path $verificationRoot "install.log"
$upgradeLog = Join-Path $verificationRoot "upgrade.log"
$uninstallLog = Join-Path $verificationRoot "uninstall.log"
$configDir = Join-Path $env:APPDATA "agentroom"
$stateSentinel = Join-Path $configDir "installer-smoke.keep"
$stateValue = [guid]::NewGuid().ToString("N")
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{2FA4C87B-E4E4-4929-B229-8F2B13DB1EF6}_is1"
$startMenuLink = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\AgentRoom Bridge\AgentRoom Bridge.lnk"

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
  $required = @(
    "AgentRoom Bridge.exe",
    "README.md",
    "LICENSE",
    "NOTICE",
    "COMMERCIAL-LICENSE.md",
    "unins000.exe"
  )
  foreach ($filename in $required) {
    $path = Join-Path $installDir $filename
    if (-not (Test-Path -LiteralPath $path) -or (Get-Item -LiteralPath $path).Length -eq 0) {
      throw "Installed payload is missing $filename"
    }
  }
  $binaryText = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes((Join-Path $installDir "AgentRoom Bridge.exe")))
  if (-not $binaryText.Contains($ReleaseTag)) {
    throw "Installed Bridge does not contain $ReleaseTag"
  }
  if (-not (Test-Path -LiteralPath $startMenuLink)) {
    throw "Installer did not create the current-user Start menu shortcut"
  }
  if (-not (Test-Path -LiteralPath $uninstallKey)) {
    throw "Installer did not register a current-user uninstaller"
  }
  $registration = Get-ItemProperty -LiteralPath $uninstallKey
  if ($registration.DisplayName -ne "AgentRoom Bridge" -or $registration.DisplayVersion -ne $version) {
    throw ("Installed application registration has unexpected name or version: " +
      "DisplayName='$($registration.DisplayName)', DisplayVersion='$($registration.DisplayVersion)'")
  }
}

if (Test-Path -LiteralPath $stateSentinel) {
  throw "Installer verification refuses to replace existing owner state: $stateSentinel"
}

New-Item -ItemType Directory -Path $verificationRoot -Force | Out-Null
New-Item -ItemType Directory -Path $configDir -Force | Out-Null
Set-Content -LiteralPath $stateSentinel -Value $stateValue -NoNewline
try {
  $installArguments = @(
    "/VERYSILENT",
    "/SUPPRESSMSGBOXES",
    "/NORESTART",
    "/DIR=`"$installDir`"",
    "/LOG=`"$installLog`""
  )
  Invoke-CheckedProcess $installer $installArguments "Initial installer run" $installLog
  Assert-InstalledPayload

  $upgradeArguments = @(
    "/VERYSILENT",
    "/SUPPRESSMSGBOXES",
    "/NORESTART",
    "/DIR=`"$installDir`"",
    "/LOG=`"$upgradeLog`""
  )
  Invoke-CheckedProcess $installer $upgradeArguments "Installer upgrade run" $upgradeLog
  Assert-InstalledPayload
  if ((Get-Content -LiteralPath $stateSentinel -Raw) -ne $stateValue) {
    throw "Installer upgrade changed owner configuration state"
  }

  $uninstaller = Join-Path $installDir "unins000.exe"
  $uninstallArguments = @(
    "/VERYSILENT",
    "/SUPPRESSMSGBOXES",
    "/NORESTART",
    "/LOG=`"$uninstallLog`""
  )
  Invoke-CheckedProcess $uninstaller $uninstallArguments "Installer uninstall run" $uninstallLog
  if (Test-Path -LiteralPath (Join-Path $installDir "AgentRoom Bridge.exe")) {
    throw "Uninstaller left the managed Bridge executable behind"
  }
  if (Test-Path -LiteralPath $startMenuLink) {
    throw "Uninstaller left the managed Start menu shortcut behind"
  }
  if (Test-Path -LiteralPath $uninstallKey) {
    throw "Uninstaller left its current-user registration behind"
  }
  if ((Get-Content -LiteralPath $stateSentinel -Raw) -ne $stateValue) {
    throw "Uninstaller changed owner configuration state"
  }
}
finally {
  if (Test-Path -LiteralPath $stateSentinel) {
    Remove-Item -LiteralPath $stateSentinel -Force
  }
  if (Test-Path -LiteralPath $verificationRoot) {
    Remove-Item -LiteralPath $verificationRoot -Recurse -Force
  }
}

Write-Output "Verified install, upgrade, and uninstall for $installer"

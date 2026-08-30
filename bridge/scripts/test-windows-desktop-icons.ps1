[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot "windows-desktop-icons.ps1")

$bridgeRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$icon = (Resolve-Path (Join-Path $bridgeRoot "desktop\windows\icon.ico")).Path
$packageSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot "package-desktop-windows.ps1") -Raw
$checkIndex = $packageSource.IndexOf("Invoke-WindowsResourceCheck -Mode check")
$buildIndex = $packageSource.IndexOf('& go @buildArguments')
$verifyIndex = $packageSource.IndexOf("Invoke-WindowsResourceCheck -Mode verify")
if ($checkIndex -lt 0 -or $buildIndex -lt $checkIndex -or $verifyIndex -lt $buildIndex) {
  throw "Windows packaging must check resources before building and verify the resulting PE afterward"
}
$resolveIndex = $packageSource.IndexOf('$resolvedExecutable = (Resolve-Path -LiteralPath $ExecutablePath).Path')
if ($resolveIndex -lt 0 -or $resolveIndex -gt $packageSource.IndexOf("Push-Location")) {
  throw "PE verification must resolve relative output paths before changing directories"
}
$installerSource = Get-Content -LiteralPath (Join-Path $bridgeRoot "desktop\windows\installer.iss") -Raw
if (-not $installerSource.Contains("SetupIconFile={#IconFile}") -or
    @([regex]::Matches($installerSource, 'IconFilename: "\{app\}\\ConveneWire Bridge\.exe"; IconIndex: 0')).Count -ne 2) {
  throw "Installer and both shortcuts must use the explicit product icon"
}

function Assert-IconCheckFails {
  param([scriptblock]$Check)
  $rejected = $false
  try { & $Check } catch { $rejected = $true }
  if (-not $rejected) { throw "Icon inspection accepted an invalid fixture" }
}

Initialize-ConveneWireIconInspection
# Native self-comparison checks both ExtractIconEx sizes without relying on
# user-installed applications or a display-DPI assumption.
Assert-ConveneWireNativeIcon -ExecutablePath $icon -IconPath $icon
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ("convenewire-icons-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
try {
  $source = Join-Path $fixtureRoot "plain.go"
  $withoutIcon = Join-Path $fixtureRoot "plain.exe"
  [IO.File]::WriteAllText($source, "package main`nfunc main() {}`n")
  & go build -trimpath -o $withoutIcon $source
  if ($LASTEXITCODE -ne 0) { throw "Could not build the resource-free PE fixture" }
  Assert-IconCheckFails { Assert-ConveneWireNativeIcon -ExecutablePath $withoutIcon -IconPath $icon }

  $different = Join-Path $fixtureRoot "different.ico"
  $differentIcon = [Drawing.SystemIcons]::Warning.Clone()
  $stream = [IO.File]::Create($different)
  try { $differentIcon.Save($stream) }
  finally { $stream.Dispose(); $differentIcon.Dispose() }
  Assert-IconCheckFails { Assert-ConveneWireNativeIcon -ExecutablePath $different -IconPath $icon }
  Assert-IconCheckFails { Assert-ConveneWireNativeIcon -ExecutablePath (Join-Path $fixtureRoot "missing.exe") -IconPath $icon }

  $shortcutPath = Join-Path $fixtureRoot "fixture.lnk"
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  try {
    $shortcut.TargetPath = $withoutIcon
    $shortcut.IconLocation = "$withoutIcon,0"
    $shortcut.Save()
    Assert-ConveneWireShortcutIcon -ShortcutPath $shortcutPath -ExecutablePath $withoutIcon
    $shortcut.IconLocation = "$different,0"
    $shortcut.Save()
    Assert-IconCheckFails { Assert-ConveneWireShortcutIcon -ShortcutPath $shortcutPath -ExecutablePath $withoutIcon }
    $shortcut.IconLocation = "$withoutIcon,1"
    $shortcut.Save()
    Assert-IconCheckFails { Assert-ConveneWireShortcutIcon -ShortcutPath $shortcutPath -ExecutablePath $withoutIcon }
  }
  finally {
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
  }
}
finally {
  Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}

Write-Output "Verified Windows native icon extraction, product matching, missing-resource rejection, and shortcut selection"

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw "This installer regression requires native Windows" }
$compilerCandidates = @(
  $env:ISCC_PATH,
  (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6/ISCC.exe"),
  (Join-Path $env:ProgramFiles "Inno Setup 6/ISCC.exe"),
  (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 7/ISCC.exe"),
  (Join-Path $env:ProgramFiles "Inno Setup 7/ISCC.exe")
)
$compiler = $compilerCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $compiler) { throw "Inno Setup compiler is required" }
$source = Get-Content -Raw (Join-Path $PSScriptRoot "../desktop/windows/installer.iss")
$code = ($source -split '(?m)^\[Code\]\r?\n', 2)[1]
# Only this disposable fixture forces the missing-runtime branch. Never modify
# the machine's WebView2 registry or run the real product installer here.
$runtimePattern = '(?s)function WebView2RuntimeInstalled: Boolean;.*?end;'
if ([regex]::Matches($code, $runtimePattern).Count -ne 1) { throw "Missing prerequisite function" }
$code = [regex]::Replace($code, $runtimePattern,
  'function WebView2RuntimeInstalled: Boolean; begin Result := False; end;')
$message = [regex]::Match($source, '(?m)^english\.WebView2Missing=[^\r\n]+').Value
if (-not $message) { throw "Missing prerequisite message" }
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ("convenewire-silent-prerequisite-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
try {
  foreach ($mutated in @($false, $true)) {
    $name = if ($mutated) { "blocking-mutant" } else { "suppressible" }
    $fixtureCode = $code
    if ($mutated) {
      $fixtureCode = $fixtureCode.Replace("SuppressibleMsgBox(", "MsgBox(").Replace(", MB_OK, IDOK)", ", MB_OK)")
      if ($fixtureCode -eq $code) { throw "Missing mutation target" }
    }
    # No Files, Registry, Icons, Run, app directory or uninstaller sections.
    $fixture = @"
[Setup]
AppName=ConveneWire isolated prerequisite test
AppVersion=1.0
CreateAppDir=no
Uninstallable=no
PrivilegesRequired=lowest
OutputDir=$fixtureRoot
OutputBaseFilename=$name
[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
[CustomMessages]
$message
[Code]
$fixtureCode
"@
    $scriptPath = Join-Path $fixtureRoot "$name.iss"
    [IO.File]::WriteAllText($scriptPath, $fixture)
    & $compiler /Q $scriptPath
    if ($LASTEXITCODE -ne 0) { throw "Prerequisite fixture compilation failed" }
    foreach ($mode in @("/SILENT", "/VERYSILENT")) {
      $process = Start-Process -FilePath (Join-Path $fixtureRoot "$name.exe") -ArgumentList @(
        $mode, "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-"
      ) -PassThru
      try {
        $timeout = if ($mutated) { 10000 } else { 45000 }
        $exited = $process.WaitForExit($timeout)
        if ($mutated -and $exited) { throw "Blocking MsgBox mutation unexpectedly completed" }
        if (-not $mutated -and (-not $exited -or $process.ExitCode -ne 0)) {
          throw "Missing-WebView2 $mode installation blocked or failed"
        }
      }
      finally {
        if (-not $process.HasExited) {
          $process.Kill($true)
          $process.WaitForExit()
        }
        $process.Dispose()
      }
    }
  }
}
finally { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force }
Write-Output "Verified missing-WebView2 silent modes and blocking MsgBox negative control"

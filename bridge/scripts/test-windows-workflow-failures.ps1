[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
# Keep native nonzero exits non-terminating, as on the affected runners: the
# actual workflow guard, not a session preference, must stop execution.
$PSNativeCommandUseErrorActionPreference = $false
$repositoryRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$nativeShell = (Get-Process -Id $PID).Path
$checked = 0

function go {
  # Never run real Go or package anything in this failure-injection test.
  & $nativeShell -NoProfile -NonInteractive -Command "exit $script:injectedExit"
  Set-Variable -Name LASTEXITCODE -Value $LASTEXITCODE -Scope 1
}

foreach ($name in @("ci.yml", "release-bridge.yml")) {
  $source = Get-Content -Raw (Join-Path $repositoryRoot ".github/workflows/$name")
  $job = [regex]::Match($source, '(?ms)^  desktop-windows:\r?\n.*?(?=^  [a-z0-9-]+:|\z)').Value
  $checks = [regex]::Matches($job, '(?m)^          go (?:test|vet|run) [^\r\n]+\r?\n[^\r\n]*')
  if ($checks.Count -lt 5) { throw "Missing native workflow checks in $name" }
  foreach ($check in $checks) {
    $snippet = $check.Value.Trim()
    foreach ($script:injectedExit in @(23, 0)) {
      $reachedNextCommand = $false
      $caught = $false
      try {
        Invoke-Expression $snippet
        $reachedNextCommand = $true
      }
      catch { $caught = $true }
      if ($injectedExit -eq 23 -and (-not $caught -or $reachedNextCommand)) {
        throw "Native failure was masked in ${name}: $snippet"
      }
      if ($injectedExit -eq 0 -and ($caught -or -not $reachedNextCommand)) {
        throw "Successful native check did not continue in ${name}: $snippet"
      }
    }
    $checked++
  }
}
Write-Output "Verified $checked actual workflow guards with native exit 23 and exit 0"

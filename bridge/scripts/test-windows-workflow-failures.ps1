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
  $script:stubInvocations++
  # Read this child's exit code, not a shadowed LASTEXITCODE left by the prior
  # injection in the caller's scope (Windows can otherwise reuse exit 23).
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new($nativeShell)
  $startInfo.UseShellExecute = $false
  foreach ($argument in @("-NoProfile", "-NonInteractive", "-Command", "exit $script:injectedExit")) {
    $startInfo.ArgumentList.Add($argument)
  }
  $process = [System.Diagnostics.Process]::Start($startInfo)
  try {
    if (-not $process.WaitForExit(10000)) {
      $process.Kill($true)
      throw "Native exit injection timed out"
    }
    if ($process.ExitCode -ne $script:injectedExit) {
      throw "Native child returned an unexpected exit code"
    }
    Set-Variable -Name LASTEXITCODE -Value $process.ExitCode -Scope 1
  }
  finally { $process.Dispose() }
}

foreach ($name in @("ci.yml", "release-bridge.yml")) {
  $source = Get-Content -Raw (Join-Path $repositoryRoot ".github/workflows/$name")
  $job = [regex]::Match($source, '(?ms)^  desktop-windows:\r?\n.*?(?=^  [a-z0-9-]+:|\z)').Value
  $checks = [regex]::Matches($job, '(?m)^          go (?:test|vet|run) [^\r\n]+\r?\n[^\r\n]*')
  if ($checks.Count -lt 5) { throw "Missing native workflow checks in $name" }
  foreach ($check in $checks) {
    $snippet = $check.Value.Trim()
    foreach ($script:injectedExit in @(23, 0)) {
      $script:stubInvocations = 0
      $reachedNextCommand = $false
      $caught = $false
      $failure = ""
      try {
        Invoke-Expression $snippet
        $reachedNextCommand = $true
      }
      catch {
        $caught = $true
        $failure = $_.Exception.Message
      }
      if ($stubInvocations -ne 1) {
        throw "Native stub was not invoked exactly once in ${name}: $snippet; cause: $failure"
      }
      if ($injectedExit -eq 23 -and (-not $caught -or $reachedNextCommand)) {
        throw "Native failure was masked in ${name}: $snippet"
      }
      if ($injectedExit -eq 0 -and ($caught -or -not $reachedNextCommand)) {
        throw "Successful native check did not continue in ${name}: $snippet; cause: $failure"
      }
    }
    $checked++
  }
}
Write-Output "Verified $checked actual workflow guards with native exit 23 and exit 0"

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$source = Get-Content -Raw (Join-Path $PSScriptRoot "package-desktop-windows.ps1")
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$null, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
# Evaluate the actual production path initialization and path/argument ASTs.
# No Go build, registry access, installer execution or real product directories.
$start = $source.IndexOf('if ([string]::IsNullOrWhiteSpace($OutputDir))')
$end = $source.IndexOf('if ([string]::IsNullOrWhiteSpace($ReleaseTag))')
if ($start -lt 0 -or $end -le $start) { throw "Missing output initialization" }
$initialize = $source.Substring($start, $end - $start)
$assignments = @{}
foreach ($name in @("package", "staging", "binary", "cliBinary", "archive", "installerBase", "installer", "buildArguments", "cliBuildArguments", "compilerArguments")) {
  $matches = @($ast.FindAll({ param($node)
    $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq ('$' + $name)
  }, $true))
  if ($matches.Count -ne 1) { throw "Missing/ambiguous production assignment: $name" }
  $assignments[$name] = $matches[0].Extent.Text
}
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ("convenewire-output-paths-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
try {
  $bridgeRoot = Join-Path $fixtureRoot "bridge"
  $otherDirectory = Join-Path $fixtureRoot "compiler cwd"
  New-Item -ItemType Directory -Path $bridgeRoot, $otherDirectory | Out-Null
  $version = "0.0.0-path-test"
  $ReleaseTag = "v$version"
  $GoArch = "amd64"
  $sourceCommit = "a" * 40
  $bundleVersion = "0.0.0"
  $productIcon = Join-Path $bridgeRoot "icon.ico"
  $installerScript = Join-Path $bridgeRoot "installer.iss"
  foreach ($caller in @($fixtureRoot, $bridgeRoot)) {
    foreach ($requested in @("", "dist", "output with spaces/nested", (Join-Path $fixtureRoot "absolute output"))) {
      Push-Location $caller
      try {
        $OutputDir = $requested
        $expected = if (-not $requested) { Join-Path $bridgeRoot "dist" } else {
          $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($requested)
        }
        Invoke-Expression $initialize
        foreach ($name in @("package", "staging", "binary", "cliBinary", "archive", "installerBase", "installer", "buildArguments", "cliBuildArguments", "compilerArguments")) {
          Invoke-Expression $assignments[$name]
        }
        Push-Location $otherDirectory
        try {
          if ($OutputDir -ne $expected -or -not [IO.Path]::IsPathFullyQualified($OutputDir)) {
            throw "Output did not resolve against caller: '$requested'"
          }
          foreach ($artifact in @($binary, $cliBinary, $archive, $installer)) {
            if (-not [IO.Path]::IsPathFullyQualified($artifact) -or -not $artifact.StartsWith($expected + [IO.Path]::DirectorySeparatorChar)) {
              throw "Artifact escaped normalized output: $artifact"
            }
          }
          if ($buildArguments[$buildArguments.IndexOf("-o") + 1] -ne $binary -or
              $cliBuildArguments[$cliBuildArguments.IndexOf("-o") + 1] -ne $cliBinary -or
              $compilerArguments -notcontains "/DSourceDir=$staging" -or
              $compilerArguments -notcontains "/DOutputDir=$expected") {
            throw "Go/ISCC did not receive absolute output paths"
          }
        } finally { Pop-Location }
      } finally { Pop-Location }
    }
  }
} finally { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force }
Write-Output "Verified 8 caller/output combinations using production Go/ISCC path expressions"

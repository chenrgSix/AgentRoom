Set-StrictMode -Version Latest

function ConvertTo-ConveneWireSemanticVersion {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ReleaseTag
  )

  $pattern = '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?\z'
  $match = [regex]::Match(
    $ReleaseTag,
    $pattern,
    [Text.RegularExpressions.RegexOptions]::CultureInvariant
  )
  if (-not $match.Success) {
    throw "Release tag is not one canonical SemVer value: $ReleaseTag"
  }

  $preRelease = if ($match.Groups[4].Success) {
    @($match.Groups[4].Value.Split('.'))
  }
  else {
    @()
  }
  foreach ($identifier in $preRelease) {
    if ($identifier -match '^[0-9]+$' -and
        $identifier.Length -gt 1 -and $identifier.StartsWith('0')) {
      throw "Numeric prerelease identifiers cannot contain leading zeroes: $ReleaseTag"
    }
  }

  return [pscustomobject]@{
    Major = [Numerics.BigInteger]::Parse(
      $match.Groups[1].Value,
      [Globalization.CultureInfo]::InvariantCulture
    )
    Minor = [Numerics.BigInteger]::Parse(
      $match.Groups[2].Value,
      [Globalization.CultureInfo]::InvariantCulture
    )
    Patch = [Numerics.BigInteger]::Parse(
      $match.Groups[3].Value,
      [Globalization.CultureInfo]::InvariantCulture
    )
    PreRelease = $preRelease
  }
}

function Compare-ConveneWireSemanticVersion {
  param(
    [Parameter(Mandatory = $true)]
    [psobject]$Left,
    [Parameter(Mandatory = $true)]
    [psobject]$Right
  )

  foreach ($component in @('Major', 'Minor', 'Patch')) {
    $comparison = $Left.$component.CompareTo($Right.$component)
    if ($comparison -ne 0) {
      return $comparison
    }
  }

  $leftPreRelease = @($Left.PreRelease)
  $rightPreRelease = @($Right.PreRelease)
  if ($leftPreRelease.Count -eq 0 -and $rightPreRelease.Count -eq 0) {
    return 0
  }
  if ($leftPreRelease.Count -eq 0) {
    return 1
  }
  if ($rightPreRelease.Count -eq 0) {
    return -1
  }

  $sharedLength = [Math]::Min(
    $leftPreRelease.Count,
    $rightPreRelease.Count
  )
  for ($index = 0; $index -lt $sharedLength; $index++) {
    $leftIdentifier = $leftPreRelease[$index]
    $rightIdentifier = $rightPreRelease[$index]
    $leftNumeric = $leftIdentifier -match '^[0-9]+$'
    $rightNumeric = $rightIdentifier -match '^[0-9]+$'
    if ($leftNumeric -and $rightNumeric) {
      $comparison = [Numerics.BigInteger]::Parse(
        $leftIdentifier,
        [Globalization.CultureInfo]::InvariantCulture
      ).CompareTo([Numerics.BigInteger]::Parse(
        $rightIdentifier,
        [Globalization.CultureInfo]::InvariantCulture
      ))
    }
    elseif ($leftNumeric) {
      $comparison = -1
    }
    elseif ($rightNumeric) {
      $comparison = 1
    }
    else {
      $comparison = [string]::CompareOrdinal(
        $leftIdentifier,
        $rightIdentifier
      )
    }
    if ($comparison -ne 0) {
      return $comparison
    }
  }

  return $leftPreRelease.Count.CompareTo($rightPreRelease.Count)
}

function Assert-ConveneWireReleaseUpgrade {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PreviousReleaseTag,
    [Parameter(Mandatory = $true)]
    [string]$CandidateReleaseTag
  )

  $previous = ConvertTo-ConveneWireSemanticVersion $PreviousReleaseTag
  $candidate = ConvertTo-ConveneWireSemanticVersion $CandidateReleaseTag
  if (@($previous.PreRelease).Count -ne 0) {
    throw "Previous Release must be one stable SemVer version"
  }
  if ((Compare-ConveneWireSemanticVersion $candidate $previous) -le 0) {
    throw "Candidate Release must have greater SemVer precedence than previous stable Release"
  }
}

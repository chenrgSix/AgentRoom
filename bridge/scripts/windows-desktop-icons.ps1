# Native Shell extraction deliberately avoids ExtractAssociatedIcon, which can
# return a system fallback even when an executable has no icon resources.
function Initialize-ConveneWireIconInspection {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw "Desktop icon inspection requires native Windows"
  }
  Add-Type -AssemblyName System.Drawing
  if (-not ("ConveneWire.WindowsIconNative" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace ConveneWire {
  public static class WindowsIconNative {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, EntryPoint = "ExtractIconExW", ExactSpelling = true, SetLastError = true)]
    public static extern uint ExtractIconEx(string file, int index,
      [Out] IntPtr[] large, [Out] IntPtr[] small, uint count);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool DestroyIcon(IntPtr icon);
  }
}
'@
  }
}

function Remove-ConveneWireIconPair {
  param($Icons)
  if ($null -eq $Icons) { return }
  if ($Icons.Large -ne [IntPtr]::Zero) {
    [void][ConveneWire.WindowsIconNative]::DestroyIcon($Icons.Large)
  }
  if ($Icons.Small -ne [IntPtr]::Zero -and $Icons.Small -ne $Icons.Large) {
    [void][ConveneWire.WindowsIconNative]::DestroyIcon($Icons.Small)
  }
}

function Get-ConveneWireIconPair {
  param([Parameter(Mandatory = $true)][string]$Path)
  $resolved = (Resolve-Path -LiteralPath $Path).Path
  $large = [IntPtr[]]@([IntPtr]::Zero)
  $small = [IntPtr[]]@([IntPtr]::Zero)
  $count = [ConveneWire.WindowsIconNative]::ExtractIconEx($resolved, 0, $large, $small, 1)
  $icons = [PSCustomObject]@{ Large = $large[0]; Small = $small[0] }
  if ($count -eq 0 -or $count -eq [uint32]::MaxValue -or
      $icons.Large -eq [IntPtr]::Zero -or $icons.Small -eq [IntPtr]::Zero) {
    Remove-ConveneWireIconPair $icons
    throw "Desktop payload does not contain a native extractable icon"
  }
  return $icons
}

function Assert-ConveneWireNativeIcon {
  param(
    [Parameter(Mandatory = $true)][string]$ExecutablePath,
    [Parameter(Mandatory = $true)][string]$IconPath
  )
  Initialize-ConveneWireIconInspection
  $actual = $null
  $expected = $null
  try {
    # Use the same native selection/scaling for the ICO and PE on this host,
    # instead of assuming fixed Shell icon sizes or a particular display DPI.
    $expected = Get-ConveneWireIconPair $IconPath
    $actual = Get-ConveneWireIconPair $ExecutablePath
    foreach ($size in @("Large", "Small")) {
      $actualIcon = $null
      $expectedIcon = $null
      $actualBitmap = $null
      $expectedBitmap = $null
      try {
        $actualIcon = [Drawing.Icon]::FromHandle($actual.$size)
        $expectedIcon = [Drawing.Icon]::FromHandle($expected.$size)
        $actualBitmap = $actualIcon.ToBitmap()
        $expectedBitmap = $expectedIcon.ToBitmap()
        if ($actualBitmap.Size -ne $expectedBitmap.Size) {
          throw "Desktop payload icon dimensions differ from the product icon"
        }
        for ($y = 0; $y -lt $actualBitmap.Height; $y++) {
          for ($x = 0; $x -lt $actualBitmap.Width; $x++) {
            $actualPixel = $actualBitmap.GetPixel($x, $y)
            $expectedPixel = $expectedBitmap.GetPixel($x, $y)
            # Fully transparent RGB is not visible and may be normalized by
            # the Windows PNG/mask decoder; alpha and visible RGB must match.
            if ($actualPixel.A -ne $expectedPixel.A -or
                ($actualPixel.A -ne 0 -and $actualPixel.ToArgb() -ne $expectedPixel.ToArgb())) {
              throw "Desktop payload native icon differs from the product icon"
            }
          }
        }
      }
      finally {
        if ($null -ne $actualBitmap) { $actualBitmap.Dispose() }
        if ($null -ne $expectedBitmap) { $expectedBitmap.Dispose() }
        if ($null -ne $actualIcon) { $actualIcon.Dispose() }
        if ($null -ne $expectedIcon) { $expectedIcon.Dispose() }
      }
    }
  }
  finally {
    # Icon.FromHandle does not own these native handles.
    Remove-ConveneWireIconPair $actual
    Remove-ConveneWireIconPair $expected
  }
}

function Assert-ConveneWireShortcutIcon {
  param(
    [Parameter(Mandatory = $true)][string]$ShortcutPath,
    [Parameter(Mandatory = $true)][string]$ExecutablePath
  )
  $shell = $null
  $shortcut = $null
  try {
    $expected = [IO.Path]::GetFullPath($ExecutablePath)
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut((Resolve-Path -LiteralPath $ShortcutPath).Path)
    if (-not [StringComparer]::OrdinalIgnoreCase.Equals(
        [IO.Path]::GetFullPath($shortcut.TargetPath), $expected)) {
      throw "Installed shortcut targets a different executable"
    }
    $location = [string]$shortcut.IconLocation
    $match = [regex]::Match($location, '^(.*),\s*0$')
    if (-not $match.Success) {
      throw "Installed shortcut does not select product icon index zero"
    }
    $iconFile = [IO.Path]::GetFullPath($match.Groups[1].Value.Trim().Trim('"'))
    if (-not [StringComparer]::OrdinalIgnoreCase.Equals($iconFile, $expected)) {
      throw "Installed shortcut selects a different icon file"
    }
  }
  finally {
    if ($null -ne $shortcut) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
    if ($null -ne $shell) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
  }
}

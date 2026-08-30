// Package desktopicons embeds the product mark for the Windows desktop shell.
// The same source produces its PE and installer icons; see tools/windows-resources.
package desktopicons

import _ "embed"

// Windows is the 256px PNG generated from the repository's existing product SVG.
//
//go:embed windows.png
var Windows []byte

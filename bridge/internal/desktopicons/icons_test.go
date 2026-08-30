package desktopicons

import (
	"bytes"
	"image/png"
	"testing"
)

func TestWindowsIconIsVisibleProductPNG(t *testing.T) {
	icon, err := png.Decode(bytes.NewReader(Windows))
	if err != nil {
		t.Fatal(err)
	}
	if icon.Bounds().Dx() != 256 || icon.Bounds().Dy() != 256 {
		t.Fatal("native icon must retain its 256px source resolution")
	}
	_, _, _, cornerAlpha := icon.At(0, 0).RGBA()
	if cornerAlpha != 0 {
		t.Fatal("product icon must preserve its transparent rounded corners")
	}
	background, foreground := false, false
	for y := 0; y < 256; y++ {
		for x := 0; x < 256; x++ {
			r, g, b, a := icon.At(x, y).RGBA()
			background = background || (r == 0x1818 && g == 0x3e3e && b == 0x3232 && a == 0xffff)
			foreground = foreground || (r == 0xd2d2 && g == 0xefef && b == 0x8b8b && a == 0xffff)
		}
	}
	if !background || !foreground {
		t.Fatal("product icon is blank or missing its branded foreground/background")
	}
	// These points lie on the C-shaped arc, not just the easier straight arrow.
	// A parser that loses compact SVG arc flags or forgets to scale the stroke
	// can still produce a valid PNG with both brand colors, but the wrong mark.
	for _, x := range []int{58, 64} {
		r, g, b, a := icon.At(x, 128).RGBA()
		if r != 0xd2d2 || g != 0xefef || b != 0x8b8b || a != 0xffff {
			t.Fatal("product curve or its scaled stroke width was lost during conversion")
		}
	}
}

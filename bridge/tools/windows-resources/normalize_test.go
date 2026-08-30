package main

import (
	"bytes"
	"image/color"
	"strings"
	"testing"
)

func TestSVGNormalizationPreservesCompactArcAndRectangleDefaults(t *testing.T) {
	compact := productSVG(t)
	explicit := bytes.ReplaceAll(compact, []byte(`rx="12"`), []byte(`rx="12" ry="12"`))
	explicit = bytes.ReplaceAll(explicit, []byte(`a8 8 0 000 16`), []byte(`a 8 8 0 0 0 0 16`))
	for _, size := range iconSizes {
		first, err := renderSVG(compact, size)
		if err != nil {
			t.Fatal(err)
		}
		second, err := renderSVG(explicit, size)
		if err != nil || !bytes.Equal(first.Pix, second.Pix) {
			t.Fatal("SVG shorthand changed source geometry", err)
		}
	}
	for source, expected := range map[string]string{
		"M1,2a8 8 0 000 16":             "M 1 2 a 8 8 0 0 0 0 16 ",
		"M1 2A8 8 0 0110-5Z":            "M 1 2 A 8 8 0 0 1 10 -5 Z ",
		"m+1e1-.2L1E+1.5 3 4z":          "m 10 -0.2 L 10 0.5 3 4 z ",
		"M0 0a8 8 0 01-5-6 3 3 0 001 2": "M 0 0 a 8 8 0 0 1 -5 -6 3 3 0 0 0 1 2 ",
	} {
		actual, err := normalizePath(source)
		if err != nil || actual != expected {
			t.Errorf("path shorthand %q: got %q, want %q: %v", source, actual, expected, err)
		}
	}
	for _, source := range []string{"", "L1 2", "M1", "M0 0a8 8 0 2 0 1 1", "M0 0A8 8 0 0", "M0 0X1 2", "M0 0LNaN 1", "M0 0L1e100 0", "M,1 2", "M1,,2", "M1 2,", "M1 2,L3 4"} {
		if _, err := normalizePath(source); err == nil {
			t.Errorf("malformed path accepted: %q", source)
		}
	}
}

func TestProductSVGHasRoundedCornersCompleteCurveAndScaledStroke(t *testing.T) {
	canvas, err := renderSVG(productSVG(t), 256)
	if err != nil {
		t.Fatal(err)
	}
	foreground := color.NRGBA{R: 0xd2, G: 0xef, B: 0x8b, A: 255}
	background := color.NRGBA{R: 0x18, G: 0x3e, B: 0x32, A: 255}
	for name, point := range map[string][2]int{
		"C left curve": {10, 20}, "C top": {23, 12}, "C bottom": {19, 28},
		"arrow shaft": {26, 20}, "arrow upper": {28, 18}, "arrow lower": {28, 22},
	} {
		actual := color.NRGBAModel.Convert(canvas.At(point[0]*256/40, point[1]*256/40)).(color.NRGBA)
		if actual != foreground {
			t.Errorf("%s is missing: got %#v", name, actual)
		}
	}
	for _, point := range [][2]int{{0, 0}, {255, 0}, {0, 255}, {255, 255}} {
		if _, _, _, alpha := canvas.At(point[0], point[1]).RGBA(); alpha != 0 {
			t.Fatal("rounded product background lost transparent corner")
		}
	}
	for _, point := range [][2]int{{8, 20}, {12, 20}, {16, 20}} {
		actual := color.NRGBAModel.Convert(canvas.At(point[0]*256/40, point[1]*256/40)).(color.NRGBA)
		if actual != background {
			t.Errorf("stroke exceeds its SVG geometry at %v: got %#v", point, actual)
		}
	}
	// At y=20 the C is vertical: width=3 SVG units must become 19.2 pixels,
	// not the unscaled 3px stroke produced by a raw oksvg SetTarget call.
	width := 0
	for x := 7 * 256 / 40; x < 13*256/40; x++ {
		pixel := color.NRGBAModel.Convert(canvas.At(x, 128)).(color.NRGBA)
		if pixel.G > 150 {
			width++
		}
	}
	if width < 18 || width > 20 {
		t.Errorf("SVG 3-unit stroke should be approximately 19px, got %d", width)
	}
}

func TestViewBoxOriginAndStrokeScaleTogether(t *testing.T) {
	base := `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none"><path d="M10 10L20 20" stroke="#d2ef8b" stroke-width="3"/></svg>`
	shifted := strings.ReplaceAll(base, `viewBox="0 0 40 40"`, `viewBox="10 10 40 40"`)
	shifted = strings.ReplaceAll(shifted, `M10 10L20 20`, `M20 20L30 30`)
	first, err := renderSVG([]byte(base), 256)
	if err != nil {
		t.Fatal(err)
	}
	second, err := renderSVG([]byte(shifted), 256)
	if err != nil || !bytes.Equal(first.Pix, second.Pix) {
		t.Fatal("viewBox offset changed rendered geometry", err)
	}
}

package main

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"math"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/srwiley/oksvg"
	"github.com/srwiley/rasterx"
	"github.com/tc-hib/winres"
)

const maxSVGBytes = 64 << 10

var iconSizes = []int{16, 24, 32, 48, 64, 128, 256}
var pathNumbers = regexp.MustCompile(`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`)
var literalColor = regexp.MustCompile(`^#[0-9A-Fa-f]{6}$`)

func splitPath(value string) []string { return strings.Split(value, string(filepath.Separator)) }

// Support exactly the self-contained SVG features currently used by mark.svg.
// A future logo using new features needs an explicit parser-policy review.
func validateSVG(source []byte) error {
	if len(source) == 0 || len(source) > maxSVGBytes {
		return errors.New("SVG exceeds its input limit")
	}
	attributes := map[string]string{
		"svg":  " xmlns viewBox fill width height ",
		"rect": " x y width height rx ry fill ",
		"path": " d fill stroke stroke-width stroke-linecap stroke-linejoin ",
	}
	decoder := xml.NewDecoder(bytes.NewReader(source))
	depth, elements, roots := 0, 0, 0
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("invalid SVG XML: %w", err)
		}
		switch value := token.(type) {
		case xml.StartElement:
			elements++
			if depth == 0 {
				roots++
				if value.Name.Local != "svg" {
					return errors.New("SVG root is required")
				}
			}
			if depth > 1 || elements > 64 || len(value.Attr) > 16 || (depth > 0 && value.Name.Local == "svg") {
				return errors.New("SVG structure exceeds the supported subset")
			}
			allowed, ok := attributes[value.Name.Local]
			if !ok || value.Name.Space != "http://www.w3.org/2000/svg" {
				return errors.New("SVG contains an unsupported or external element")
			}
			seen := map[string]bool{}
			for _, attribute := range value.Attr {
				name := attribute.Name.Local
				if seen[name] || attribute.Name.Space != "" || !strings.Contains(allowed, " "+name+" ") {
					return errors.New("SVG contains a reference or unsupported attribute")
				}
				seen[name] = true
				if strings.Contains(strings.ToLower(attribute.Value), "url(") {
					return errors.New("SVG references are forbidden")
				}
				switch name {
				case "xmlns":
					if attribute.Value != "http://www.w3.org/2000/svg" {
						return errors.New("unexpected SVG namespace")
					}
				case "fill", "stroke":
					if attribute.Value != "none" && !literalColor.MatchString(attribute.Value) {
						return errors.New("SVG colors must be literal RGB values")
					}
				case "stroke-linecap":
					if attribute.Value != "round" && attribute.Value != "butt" && attribute.Value != "square" {
						return errors.New("unsupported SVG line cap")
					}
				case "stroke-linejoin":
					if attribute.Value != "round" && attribute.Value != "miter" && attribute.Value != "bevel" {
						return errors.New("unsupported SVG line join")
					}
				case "d":
					// normalizePath checks complete tokens and bounds, including
					// adjacent flags which must not be mistaken for one number.
				default:
					for _, number := range pathNumbers.FindAllString(attribute.Value, -1) {
						parsed, err := strconv.ParseFloat(number, 64)
						if err != nil || math.IsInf(parsed, 0) || math.IsNaN(parsed) || math.Abs(parsed) > 4096 {
							return errors.New("SVG coordinate exceeds its rendering limit")
						}
					}
				}
			}
			depth++
		case xml.EndElement:
			depth--
		case xml.Directive, xml.ProcInst:
			return errors.New("SVG directives and external entities are forbidden")
		case xml.CharData:
			if strings.TrimSpace(string(value)) != "" {
				return errors.New("SVG text content is unsupported")
			}
		}
	}
	if roots != 1 || depth != 0 {
		return errors.New("exactly one SVG root is required")
	}
	return nil
}

func renderSVG(source []byte, size int) (*image.RGBA, error) {
	normalized, err := normalizeSVG(source)
	if err != nil {
		return nil, err
	}
	icon, err := oksvg.ReadIconStream(bytes.NewReader(normalized), oksvg.StrictErrorMode)
	if err != nil {
		return nil, fmt.Errorf("parse supported SVG: %w", err)
	}
	if icon.ViewBox.W <= 0 || icon.ViewBox.H <= 0 || icon.ViewBox.W != icon.ViewBox.H || icon.ViewBox.W > 4096 || math.IsNaN(icon.ViewBox.W) || math.IsInf(icon.ViewBox.W, 0) {
		return nil, errors.New("SVG viewBox must be a bounded square")
	}
	canvas := image.NewRGBA(image.Rect(0, 0, size, size))
	scale := float64(size) / icon.ViewBox.W
	icon.Transform = rasterx.Identity.Scale(scale, scale).Translate(-icon.ViewBox.X, -icon.ViewBox.Y)
	// oksvg's SetTarget transforms path coordinates, but not stroke widths.
	// The supported subset has a square viewBox and no element transforms, so
	// SVG's default scaling stroke is exactly this uniform scale.
	for index := range icon.SVGPaths {
		icon.SVGPaths[index].LineWidth *= scale
	}
	scanner := rasterx.NewScannerGV(size, size, canvas, canvas.Bounds())
	icon.Draw(rasterx.NewDasher(size, size, scanner), 1)
	return canvas, nil
}

func generateArtifacts(source []byte) ([]artifact, *winres.ResourceSet, error) {
	if err := validateSVG(source); err != nil {
		return nil, nil, err
	}
	images := make([]*image.RGBA, 0, len(iconSizes))
	for _, size := range iconSizes {
		image, err := renderSVG(source, size)
		if err != nil {
			return nil, nil, err
		}
		images = append(images, image)
	}
	var pngOutput bytes.Buffer
	if err := png.Encode(&pngOutput, images[len(images)-1]); err != nil {
		return nil, nil, err
	}
	ico, err := encodeICO(images)
	if err != nil {
		return nil, nil, err
	}
	icon, err := winres.LoadICO(bytes.NewReader(ico))
	if err != nil {
		return nil, nil, err
	}
	resources := &winres.ResourceSet{}
	if err := resources.SetIcon(winres.ID(3), icon); err != nil {
		return nil, nil, err
	}
	// Wails webview windows request group 3; its application window class asks
	// the same module for IDI_APPLICATION (32512). Both share the seven images.
	if err := resources.Set(winres.RT_GROUP_ICON, winres.ID(32512), winres.LCIDNeutral,
		bytes.Clone(resources.Get(winres.RT_GROUP_ICON, winres.ID(3), winres.LCIDNeutral))); err != nil {
		return nil, nil, err
	}
	var object bytes.Buffer
	if err := resources.WriteObject(&object, winres.ArchAMD64); err != nil {
		return nil, nil, err
	}
	return []artifact{
		{"bridge/internal/desktopicons/windows.png", pngOutput.Bytes()},
		{"bridge/desktop/windows/icon.ico", ico},
		{"bridge/cmd/convenewire-bridge-desktop/icon_windows_amd64.syso", object.Bytes()},
	}, resources, nil
}

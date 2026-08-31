package main

import (
	"bytes"
	"context"
	"debug/pe"
	"encoding/binary"
	"image/color"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tc-hib/winres"
)

func productSVG(t *testing.T) []byte {
	t.Helper()
	source, err := os.ReadFile(filepath.FromSlash("../../../site/public/mark.svg"))
	if err != nil {
		t.Fatal(err)
	}
	return source
}

func TestGeneratedResourcesAreDeterministicAndIconOnly(t *testing.T) {
	first, resources, err := generateArtifacts(productSVG(t))
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := generateArtifacts(productSVG(t))
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 3 || resources.Count() != 9 {
		t.Fatal("expected three artifacts, seven images, and two aliases")
	}
	for index := range first {
		if first[index].path != second[index].path || !bytes.Equal(first[index].data, second[index].data) {
			t.Fatal("generation is not deterministic")
		}
	}
	if !bytes.Equal(resources.Get(winres.RT_GROUP_ICON, winres.ID(3), 0), resources.Get(winres.RT_GROUP_ICON, winres.ID(32512), 0)) {
		t.Fatal("application and window icons must share the exact seven image references")
	}
	resources.Walk(func(typeID, _ winres.Identifier, _ uint16, _ []byte) bool {
		if typeID != winres.RT_ICON && typeID != winres.RT_GROUP_ICON {
			t.Fatal("resource generator changed manifest/version/permissions")
		}
		return true
	})
	object, err := pe.NewFile(bytes.NewReader(first[2].data))
	if err != nil {
		t.Fatal(err)
	}
	defer object.Close()
	if object.Machine != pe.IMAGE_FILE_MACHINE_AMD64 || object.TimeDateStamp != 0 || object.OptionalHeader != nil {
		t.Fatal("unexpected COFF architecture, timestamp, or executable header")
	}
	decoded, err := png.Decode(bytes.NewReader(first[0].data))
	if err != nil || decoded.Bounds().Dx() != 256 || decoded.Bounds().Dy() != 256 {
		t.Fatal("invalid embedded 256px PNG", err)
	}
}

func TestCheckedInResourcesMatchCanonicalRender(t *testing.T) {
	if err := run("../../..", "check", ""); err != nil {
		t.Fatalf("canonical icon resources differ (use the pinned rasterx gcflags): %v", err)
	}
}

func TestICOHasAllSizesDIBCompatibilityAndCorrectStraightAlpha(t *testing.T) {
	source := productSVG(t)
	artifacts, _, err := generateArtifacts(source)
	if err != nil {
		t.Fatal(err)
	}
	ico := artifacts[1].data
	if binary.LittleEndian.Uint16(ico[2:4]) != 1 || int(binary.LittleEndian.Uint16(ico[4:6])) != len(iconSizes) {
		t.Fatal("bad ICO directory")
	}
	end := 6 + 16*len(iconSizes)
	for index, size := range iconSizes {
		entry := ico[6+16*index : 6+16*(index+1)]
		if entry[0] != byte(size) || entry[1] != byte(size) || binary.LittleEndian.Uint16(entry[4:6]) != 1 || binary.LittleEndian.Uint16(entry[6:8]) != 32 {
			t.Fatal("bad ICO image descriptor")
		}
		length, offset := int(binary.LittleEndian.Uint32(entry[8:12])), int(binary.LittleEndian.Uint32(entry[12:16]))
		if offset != end || length <= 0 || offset+length > len(ico) {
			t.Fatal("ICO image is truncated, overlapping, or out of order")
		}
		end = offset + length
		data := ico[offset:end]
		if size == 256 {
			image, err := png.Decode(bytes.NewReader(data))
			if err != nil || image.Bounds().Dx() != size || image.Bounds().Dy() != size {
				t.Fatal("large icon must be a valid PNG", err)
			}
			continue
		}
		maskStride := ((size + 31) / 32) * 4
		if len(data) != 40+size*size*4+size*maskStride || binary.LittleEndian.Uint32(data[:4]) != 40 || int(binary.LittleEndian.Uint32(data[8:12])) != size*2 {
			t.Fatal("small icon must be a complete bottom-up DIB and AND mask")
		}
		expected, err := renderSVG(source, size)
		if err != nil {
			t.Fatal(err)
		}
		transparent, partial := false, false
		for y := 0; y < size; y++ {
			for x := 0; x < size; x++ {
				pixel := color.NRGBAModel.Convert(expected.At(x, y)).(color.NRGBA)
				position := 40 + ((size-1-y)*size+x)*4
				if !bytes.Equal(data[position:position+4], []byte{pixel.B, pixel.G, pixel.R, pixel.A}) {
					t.Fatal("DIB orientation or unpremultiplied alpha changed")
				}
				mask := data[40+size*size*4+(size-1-y)*maskStride+x/8] & (1 << (7 - uint(x%8)))
				if (mask != 0) != (pixel.A == 0) {
					t.Fatal("AND transparency mask differs from image alpha")
				}
				transparent = transparent || pixel.A == 0
				partial = partial || (pixel.A > 0 && pixel.A < 255)
			}
		}
		if !transparent || !partial {
			t.Fatal("icon lost transparent corners or antialiasing")
		}
	}
	if end != len(ico) {
		t.Fatal("unexpected trailing ICO bytes")
	}
}

func TestSVGRejectsReferencesAndUnsupportedMarkup(t *testing.T) {
	for _, body := range []string{
		`<image href="https://example.com/icon.png"/>`, `<use href="#shape"/>`, `<script>alert(1)</script>`,
		`<path d="M0 0" onload="alert(1)"/>`, `<path d="M0 0" stroke="url(https://example.com)"/>`,
		`<foreignObject/>`, `<path d="M1e100 0"/>`, `<g><rect width="40" height="40"/></g>`,
	} {
		svg := []byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">` + body + `</svg>`)
		if _, _, err := generateArtifacts(svg); err == nil {
			t.Fatalf("unsafe SVG accepted: %s", body)
		}
	}
	for _, svg := range [][]byte{
		[]byte(`<!DOCTYPE svg [<!ENTITY p SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&p;</svg>`),
		[]byte(strings.Repeat(" ", maxSVGBytes+1)), []byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 0 0"/>`),
	} {
		if _, _, err := generateArtifacts(svg); err == nil {
			t.Fatal("malformed SVG accepted")
		}
	}
}

func TestCheckDetectsEveryStaleOutputAndRejectsOutputSymlink(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, filepath.FromSlash(sourcePath))
	if err := os.MkdirAll(filepath.Dir(source), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, productSVG(t), 0644); err != nil {
		t.Fatal(err)
	}
	if err := run(root, "generate", ""); err != nil {
		t.Fatal(err)
	}
	if err := run(root, "check", ""); err != nil {
		t.Fatal(err)
	}
	outputs, _, _ := generateArtifacts(productSVG(t))
	for _, output := range outputs {
		path := filepath.Join(root, filepath.FromSlash(output.path))
		if err := os.WriteFile(path, []byte("drift"), 0644); err != nil {
			t.Fatal(err)
		}
		if err := run(root, "check", ""); err == nil {
			t.Fatalf("stale %s passed check", output.path)
		}
		if err := run(root, "generate", ""); err != nil {
			t.Fatal(err)
		}
	}
	// On native Windows, creating a symlink may require developer mode.
	path := filepath.Join(root, filepath.FromSlash(outputs[0].path))
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(source, path); err == nil {
		if err := run(root, "generate", ""); err == nil {
			t.Fatal("generator followed output symlink")
		}
	}
}

func buildPEFixture(t *testing.T, directory string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	path := filepath.Join(directory, "fixture.exe")
	command := exec.CommandContext(ctx, "go", "build", "-trimpath", "-o", path, ".")
	command.Dir = directory
	command.Env = append(os.Environ(), "GOOS=windows", "GOARCH=amd64", "CGO_ENABLED=0", "GOWORK=off", "GOFLAGS=")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("build real PE fixture: %v\n%s", err, output)
	}
	return path
}

func TestVerifyParsesRealPEAndRejectsMissingCorruptOrWrongBrand(t *testing.T) {
	artifacts, expected, err := generateArtifacts(productSVG(t))
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	for name, content := range map[string][]byte{"go.mod": []byte("module iconfixture\n\ngo 1.26.7\n"), "main.go": []byte("package main\nfunc main() {}\n"), "icon_windows_amd64.syso": artifacts[2].data} {
		if err := os.WriteFile(filepath.Join(root, name), content, 0644); err != nil {
			t.Fatal(err)
		}
	}
	executable := buildPEFixture(t, root)
	if err := verifyExecutable(executable, expected); err != nil {
		t.Fatal("linked brand resources rejected", err)
	}
	valid, err := os.ReadFile(executable)
	if err != nil {
		t.Fatal(err)
	}
	corrupt := bytes.Clone(valid)
	imageBytes := expected.Get(winres.RT_ICON, winres.ID(1), 0)
	position := bytes.Index(corrupt, imageBytes)
	if position < 0 {
		t.Fatal("PE did not contain embedded image bytes")
	}
	corrupt[position+len(imageBytes)/2] ^= 1
	if err := os.WriteFile(executable, corrupt, 0644); err != nil {
		t.Fatal(err)
	}
	if err := verifyExecutable(executable, expected); err == nil {
		t.Fatal("corrupt embedded image passed")
	}
	if err := os.Remove(filepath.Join(root, "icon_windows_amd64.syso")); err != nil {
		t.Fatal(err)
	}
	executable = buildPEFixture(t, root)
	if err := verifyExecutable(executable, expected); err == nil {
		t.Fatal("resource-free real PE passed")
	}
	blank, err := os.ReadFile(executable)
	if err != nil {
		t.Fatal(err)
	}
	wrongSVG := bytes.Replace(productSVG(t), []byte("#d2ef8b"), []byte("#ff0000"), -1)
	_, wrong, err := generateArtifacts(wrongSVG)
	if err != nil {
		t.Fatal(err)
	}
	var patched bytes.Buffer
	if err := wrong.WriteToEXE(&patched, bytes.NewReader(blank)); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(executable, patched.Bytes(), 0644); err != nil {
		t.Fatal(err)
	}
	if err := verifyExecutable(executable, expected); err == nil {
		t.Fatal("wrong brand passed despite valid PE/group structure")
	}
	for _, data := range [][]byte{[]byte("MZ"), valid[:128]} {
		if err := os.WriteFile(executable, data, 0644); err != nil {
			t.Fatal(err)
		}
		if err := verifyExecutable(executable, expected); err == nil {
			t.Fatal("truncated PE passed")
		}
	}
}

func TestPEResourceParserRejectsCyclesAndOutOfBoundsOffsets(t *testing.T) {
	for _, offset := range []uint32{0, 0x7ffffff0} {
		raw := make([]byte, 24)
		binary.LittleEndian.PutUint16(raw[14:16], 1)
		binary.LittleEndian.PutUint32(raw[16:20], 3)
		binary.LittleEndian.PutUint32(raw[20:24], 0x80000000|offset)
		if _, err := readPEResources(raw, 0, 0); err == nil {
			t.Fatal("corrupt resource directory accepted")
		}
	}
}

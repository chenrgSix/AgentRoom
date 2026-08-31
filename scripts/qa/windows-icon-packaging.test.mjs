import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const canonicalArithmetic = "-gcflags=github.com/srwiley/rasterx=-d=fmahash=qn";

test("Windows packaging validates generated icons before build and actual icons before archiving", async () => {
  const source = await read("bridge/scripts/package-desktop-windows.ps1");
  assert.ok(source.includes(`"run", "${canonicalArithmetic}", "."`));
  const ordered = [
    "Invoke-WindowsResourceCheck -Mode check",
    "& go @buildArguments",
    "Invoke-WindowsResourceCheck -Mode verify -ExecutablePath $binary",
    "Assert-ConveneWireNativeIcon -ExecutablePath $binary -IconPath $productIcon",
    "Compress-Archive"
  ].map((marker) => source.indexOf(marker));
  assert.ok(ordered.every((position, index) => position >= 0 && (index === 0 || position > ordered[index - 1])));
  assert.ok(source.includes('"/DIconFile=$productIcon"'));
  assert.ok(source.includes("Assert-ConveneWireNativeIcon -ExecutablePath $installer -IconPath $productIcon"));
});

test("Windows installer and shortcuts select the same product icon without owning user data", async () => {
  const source = await read("bridge/desktop/windows/installer.iss");
  assert.ok(source.includes("SetupIconFile={#IconFile}"));
  assert.equal(source.match(/IconFilename: "\{app\}\\ConveneWire Bridge\.exe"; IconIndex: 0/gu)?.length, 2);
  assert.ok(source.includes("UninstallDisplayIcon={app}\\ConveneWire Bridge.exe"));
  assert.ok(source.includes("PrivilegesRequired=lowest"));
  assert.match(source, /Name: "desktopicon";[^\n]*Flags: unchecked/u);
});

test("missing-WebView2 warning is suppressible and the native regression cannot alter real registration", async () => {
  const installer = await read("bridge/desktop/windows/installer.iss");
  assert.match(installer, /SuppressibleMsgBox\(ExpandConstant\('\{cm:WebView2Missing\}'\), mbInformation, MB_OK, IDOK\)/u);
  assert.doesNotMatch(installer, /\bMsgBox\(/u);
  const regression = await read("bridge/scripts/test-windows-silent-prerequisite.ps1");
  assert.ok(regression.includes("begin Result := False; end;"));
  assert.ok(regression.includes('"/SILENT", "/VERYSILENT"'));
  assert.ok(regression.includes('"/SUPPRESSMSGBOXES"'));
  assert.ok(regression.includes("$process.WaitForExit($timeout)"));
  assert.ok(regression.includes("$process.Kill($true)"));
  assert.ok(regression.includes("CreateAppDir=no"));
  assert.ok(regression.includes("Uninstallable=no"));
  assert.doesNotMatch(regression, /\[(?:Registry|Files|Run|Icons)\]/u);
});

test("Native icon inspection cannot use a system fallback or only check shortcut existence", async () => {
  const inspector = await read("bridge/scripts/windows-desktop-icons.ps1");
  assert.ok(inspector.includes('EntryPoint = "ExtractIconExW"'));
  assert.ok(inspector.includes("$actualBitmap.GetPixel($x, $y)"));
  assert.ok(inspector.includes("$shortcut.IconLocation"));
  assert.ok(inspector.includes("$shortcut.TargetPath"));
  const verification = await read("bridge/scripts/verify-desktop-windows-installer.ps1");
  assert.ok(verification.includes("Assert-ConveneWireNativeIcon -ExecutablePath $installedExecutable"));
  assert.ok(verification.includes("Assert-ConveneWireShortcutIcon -ShortcutPath $startMenuLink"));
  const negatives = await read("bridge/scripts/test-windows-desktop-icons.ps1");
  assert.ok(negatives.includes("Assert-IconCheckFails { Assert-ConveneWireNativeIcon -ExecutablePath $withoutIcon"));
  assert.ok(negatives.includes("Assert-IconCheckFails { Assert-ConveneWireNativeIcon -ExecutablePath $different"));
});

for (const workflow of ["ci.yml", "release-bridge.yml"]) {
  test(`${workflow} retains icon generation checks and native Windows negative tests`, async () => {
    const source = await read(`.github/workflows/${workflow}`);
    const windows = source.slice(source.indexOf("  desktop-windows:"));
    assert.ok(windows.includes("working-directory: bridge/tools/windows-resources"));
    const iconStep = windows.slice(windows.indexOf("      - name: Test and check Windows product icon resources")).split("\n      - name:")[0];
    assert.ok(iconStep.includes(`GOFLAGS: ${canonicalArithmetic}`));
    assert.ok(windows.includes("go test ./..."));
    assert.ok(windows.includes("go vet ./..."));
    assert.match(windows, /go run \. -root [^\n]+ -mode check/u);
    assert.ok(windows.includes("./scripts/test-windows-desktop-icons.ps1"));
    assert.ok(windows.includes("./scripts/test-windows-silent-prerequisite.ps1"));
  });
}

test("CI also compares canonical icon bytes on arm64", async () => {
  const source = await read(".github/workflows/ci.yml");
  const mac = source.slice(source.indexOf("  desktop-macos:"), source.indexOf("  desktop-windows:"));
  assert.ok(mac.includes("Verify canonical Windows icons on arm64"));
  assert.ok(mac.includes(`GOFLAGS: ${canonicalArithmetic}`));
  assert.ok(mac.includes('go run . -root "$GITHUB_WORKSPACE" -mode check'));
});

export function detectedPathForDraft(currentPath, detectedPath) {
  return detectedPath || currentPath;
}

export function runtimeDiscoveryView(kind, state) {
  const name = kind === "pi" ? "Pi" : "Codex";
  const executable = kind === "pi" ? "pi" : "codex";
  const discovery = state.runtimeDiscovery?.[kind];
  const path = discovery?.path || (kind === "pi" ? state.detectedPi : state.detectedCodex) || "";
  const source = {PATH: "进程 PATH", "macOS App": "应用内置 CLI", "Homebrew / system": "常见安装目录", "user bin": "用户安装目录", nvm: "nvm 安装目录"}[discovery?.source] || "本机";
  return {
    path,
    status: path ? `检测到 ${name}（${source}）：${path}` : `未检测到 ${name}。桌面 App 的 PATH 可能与终端不同，不代表一定没安装。`,
    help: path
      ? "这里填写可执行文件本身的完整路径，不是所在目录或 .app。检测只检查文件；保存前预检可进一步检查是否能运行。"
      : `在终端运行 command -v ${executable}（Windows 用 where.exe ${executable}），把输出的完整文件路径填入上方；不要填所在目录。` +
        (kind === "pi"
          ? "常见位置是 Homebrew、用户的 .local/bin 或 .nvm/versions/node/<版本>/bin/pi。若没有输出，请先安装 Pi CLI，随后重新检测。"
          : "macOS 也可在“应用程序”里找到 ChatGPT.app 或 Codex.app → 显示包内容 → Contents/Resources/codex。常见 CLI 位置还有 /opt/homebrew/bin/codex、/usr/local/bin/codex、~/.local/bin/codex 或 nvm 的 bin 目录。若仍没有，请查看下方官方安装说明。"),
    showCodexInstall: kind === "codex" && !path,
  };
}

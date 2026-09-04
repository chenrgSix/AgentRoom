export function createClientEntryController({
  elements,
  request,
  copyText = (value) => navigator.clipboard.writeText(value)
}) {
  let state = null;
  let scope = "";
  let generation = 0;
  let busy = false;
  let availableRooms = [];
  const teamButton = elements["open-client-team"];
  const loadButton = elements["load-client-rooms"];
  const roomButton = elements["open-client-room"];
  const select = elements["client-room"];
  const status = elements["client-entry-status"];
  const help = elements["client-entry-help"];
  const trustButton = elements["prepare-private-browser"];
  const trustDialog = elements["browser-trust-dialog"];
  const trustFingerprint = elements["browser-trust-fingerprint"];
  const trustCommand = elements["browser-trust-command"];
  const trustRemovalCommand = elements["browser-trust-removal-command"];
  const trustStatus = elements["browser-trust-status"];

  function validTrustSetup(value) {
    return value && /^[a-f0-9]{64}$/u.test(value.caCertificateSha256) &&
      typeof value.windowsPowerShellCommand === "string" && value.windowsPowerShellCommand.length > 0 &&
      typeof value.windowsRemovalPowerShellCommand === "string" && value.windowsRemovalPowerShellCommand.length > 0;
  }

  function closeTrustDialog() {
    if (typeof trustDialog.close === "function" && trustDialog.open) trustDialog.close();
    else trustDialog.removeAttribute("open");
    trustFingerprint.textContent = "";
    trustCommand.value = "";
    trustRemovalCommand.value = "";
    trustStatus.textContent = "";
  }

  function openTrustDialog() {
    const setup = state?.browserTrustSetup;
    if (!validTrustSetup(setup) || state.enrollment?.active || trustDialog.hasAttribute("open")) return;
    trustFingerprint.textContent = setup.caCertificateSha256.toUpperCase();
    trustCommand.value = setup.windowsPowerShellCommand;
    trustRemovalCommand.value = setup.windowsRemovalPowerShellCommand;
    trustStatus.textContent = "";
    if (typeof trustDialog.showModal === "function") trustDialog.showModal();
    else trustDialog.setAttribute("open", "");
  }

  async function copyTrustCommand(kind) {
    const setup = state?.browserTrustSetup;
    if (!validTrustSetup(setup) || !trustDialog.hasAttribute("open")) return;
    const command = kind === "remove"
      ? setup.windowsRemovalPowerShellCommand
      : setup.windowsPowerShellCommand;
    try {
      await copyText(command);
      trustStatus.textContent = kind === "remove"
        ? "移除命令已复制；请只在先前建立信任的同一 Windows 账号中运行。"
        : "安装命令已复制；运行后请完全退出并重新打开 Chrome。";
    } catch {
      trustStatus.textContent = "复制失败。请手动选择命令文本复制；未执行任何系统更改。";
    }
  }

  function render(next) {
    state = next;
    const trustDigest = validTrustSetup(next.browserTrustSetup) ? next.browserTrustSetup.caCertificateSha256 : "";
    const nextScope = `${next.serverUrl}:${next.teamId}:${next.deviceId}:${Boolean(next.clientAccessAvailable)}:${Boolean(next.enrollment?.active)}:${next.serverTrustEpoch || ""}:${trustDigest}`;
    if (nextScope !== scope) {
      generation += 1; scope = nextScope; busy = false; availableRooms = [];
      select.replaceChildren(); select.classList.add("hidden"); roomButton.classList.add("hidden"); status.textContent = "";
      closeTrustDialog();
    }
    const available = next.clientAccessAvailable === true && !next.enrollment?.active;
    const trustAvailable = validTrustSetup(next.browserTrustSetup) && !next.enrollment?.active;
    teamButton.disabled = busy || !available;
    loadButton.disabled = busy || !available;
    roomButton.disabled = busy || !available || !availableRooms.some((room) => room.roomId === select.value);
    trustButton.disabled = !trustAvailable;
    trustButton.classList.toggle("hidden", !trustAvailable);
    help.textContent = available
      ? trustAvailable
        ? "以客户端主人的普通成员身份进入协作。另一台 Windows 尚未信任私有 CA 时，可先由本机生成核验命令。"
        : "以客户端主人的普通成员身份进入协作。浏览器会确认身份；私有 CA 仍需满足浏览器的证书要求。"
      : "此设备尚无成员入口。请让管理员确认实际主人，并使用新的成员配对链接重新配对；不会自动取得管理员身份。";
  }

  async function run(action) {
    if (busy || !state?.clientAccessAvailable || state.enrollment?.active) return;
    const current = generation;
    busy = true; status.textContent = "正在连接中央服务…"; render(state);
    try {
      await action(() => current === generation);
    } catch (error) {
      if (current === generation) status.textContent = String(error.message || "成员入口暂时不可用");
    } finally {
      if (current === generation) { busy = false; render(state); }
    }
  }

  teamButton.addEventListener("click", () => void run(async (current) => {
    await request("/api/client-access/open", {method: "POST", body: JSON.stringify({})});
    if (current()) status.textContent = "已打开浏览器，请确认成员身份后进入 Team。";
  }));
  loadButton.addEventListener("click", () => void run(async (current) => {
    const identity = await request("/api/client-access");
    if (!current()) return;
    availableRooms = identity.rooms;
    select.replaceChildren(...availableRooms.map((room) => {
      const option = select.ownerDocument.createElement("option");
      option.value = room.roomId; option.textContent = `# ${room.name}`; return option;
    }));
    select.classList.toggle("hidden", availableRooms.length === 0);
    roomButton.classList.toggle("hidden", availableRooms.length === 0);
    status.textContent = `${identity.displayName} · ${identity.teamName}${availableRooms.length ? "" : " · 暂无获准房间，请联系 Team 管理员"}`;
  }));
  select.addEventListener("change", () => { if (state) render(state); });
  roomButton.addEventListener("click", () => void run(async (current) => {
    const roomId = select.value;
    if (!availableRooms.some((room) => room.roomId === roomId)) return;
    await request("/api/client-access/open", {method: "POST", body: JSON.stringify({roomId})});
    if (current()) status.textContent = "已打开浏览器，请确认成员身份后进入房间。";
  }));
  trustButton.addEventListener("click", openTrustDialog);
  elements["copy-browser-trust-command"].addEventListener("click", () => void copyTrustCommand("install"));
  elements["copy-browser-trust-removal-command"].addEventListener("click", () => void copyTrustCommand("remove"));
  for (const id of ["close-browser-trust", "acknowledge-browser-trust"]) {
    elements[id].addEventListener("click", closeTrustDialog);
  }
  trustDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeTrustDialog();
  });
  return {render};
}

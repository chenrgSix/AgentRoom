export function createClientEntryController({elements, request}) {
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

  function render(next) {
    state = next;
    const nextScope = `${next.serverUrl}:${next.teamId}:${next.deviceId}:${Boolean(next.clientAccessAvailable)}:${Boolean(next.enrollment?.active)}`;
    if (nextScope !== scope) {
      generation += 1; scope = nextScope; busy = false; availableRooms = [];
      select.replaceChildren(); select.classList.add("hidden"); roomButton.classList.add("hidden"); status.textContent = "";
    }
    const available = next.clientAccessAvailable === true && !next.enrollment?.active;
    teamButton.disabled = busy || !available;
    loadButton.disabled = busy || !available;
    roomButton.disabled = busy || !available || !availableRooms.some((room) => room.roomId === select.value);
    help.textContent = available
      ? "以客户端主人的普通成员身份进入协作。浏览器会确认身份；私有 CA 仍需满足浏览器的证书要求。"
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
  return {render};
}

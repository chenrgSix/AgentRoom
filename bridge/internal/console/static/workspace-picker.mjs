function directoryDialogOptions(currentDirectory) {
  const directory = String(currentDirectory || "").trim();
  return {
    CanChooseDirectories: true,
    CanChooseFiles: false,
    AllowsMultipleSelection: false,
    CanCreateDirectories: true,
    Title: "选择工作区文件夹",
    ButtonText: "选择此文件夹",
    ...(directory ? {Directory: directory} : {})
  };
}

export async function chooseWorkspaceDirectory({
  input,
  button,
  openDirectory,
  createEvent = (type) => new Event(type, {bubbles: true})
}) {
  const idleText = button.textContent;
  button.disabled = true;
  button.textContent = "正在选择…";
  try {
    const selected = await openDirectory(directoryDialogOptions(input.value));
    if (typeof selected !== "string" || selected.trim() === "") return false;
    input.value = selected;
    input.dispatchEvent(createEvent("input"));
    input.dispatchEvent(createEvent("change"));
    input.focus();
    return true;
  } finally {
    button.disabled = false;
    button.textContent = idleText;
  }
}

async function loadNativeDialogs() {
  const runtime = await import("/wails/runtime.js");
  return runtime.Dialogs;
}

export async function initializeWorkspacePickers({
  root = document,
  loadDialogs = loadNativeDialogs,
  onError = () => {},
  createEvent
} = {}) {
  const buttons = [...root.querySelectorAll("[data-workspace-picker-for]")];
  if (buttons.length === 0) return false;

  let dialogs;
  try {
    dialogs = await loadDialogs();
  } catch {
    return false;
  }
  if (!dialogs || typeof dialogs.OpenFile !== "function") return false;

  for (const button of buttons) {
    const input = root.getElementById(button.dataset.workspacePickerFor);
    if (!input) continue;
    button.classList.remove("hidden");
    button.addEventListener("click", async () => {
      try {
        await chooseWorkspaceDirectory({
          input,
          button,
          openDirectory: (options) => dialogs.OpenFile(options),
          ...(createEvent ? {createEvent} : {})
        });
      } catch (error) {
        onError(error);
      }
    });
  }
  return true;
}

export { directoryDialogOptions };

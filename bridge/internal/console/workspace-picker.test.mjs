import assert from "node:assert/strict";
import test from "node:test";

import {
  chooseWorkspaceDirectory,
  directoryDialogOptions,
  initializeWorkspacePickers
} from "./static/workspace-picker.mjs";

function inputStub(value) {
  return {
    value,
    events: [],
    focused: false,
    dispatchEvent(event) { this.events.push(event.type); },
    focus() { this.focused = true; }
  };
}

function buttonStub(target = "codex-workspace") {
  return {
    textContent: "选择文件夹",
    disabled: false,
    dataset: {workspacePickerFor: target},
    listeners: new Map(),
    classList: {
      hidden: true,
      remove(name) { if (name === "hidden") this.hidden = false; }
    },
    addEventListener(name, listener) { this.listeners.set(name, listener); }
  };
}

const createEvent = (type) => ({type});

test("directory picker requests one folder and starts from the visible Workspace", () => {
  assert.deepEqual(directoryDialogOptions(" /Users/owner/project "), {
    CanChooseDirectories: true,
    CanChooseFiles: false,
    AllowsMultipleSelection: false,
    CanCreateDirectories: true,
    Title: "选择工作区文件夹",
    ButtonText: "选择此文件夹",
    Directory: "/Users/owner/project"
  });
});

test("selected folder replaces the Workspace and announces the form change", async () => {
  const input = inputStub("/Users/owner/old");
  const button = buttonStub();
  let options;

  const changed = await chooseWorkspaceDirectory({
    input,
    button,
    createEvent,
    openDirectory: async (received) => {
      options = received;
      return "/Users/owner/new project";
    }
  });

  assert.equal(changed, true);
  assert.equal(options.Directory, "/Users/owner/old");
  assert.equal(input.value, "/Users/owner/new project");
  assert.deepEqual(input.events, ["input", "change"]);
  assert.equal(input.focused, true);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "选择文件夹");
});

test("cancelling folder selection preserves the current Workspace", async () => {
  const input = inputStub("C:\\work\\current");
  const button = buttonStub();

  const changed = await chooseWorkspaceDirectory({
    input,
    button,
    createEvent,
    openDirectory: async () => ""
  });

  assert.equal(changed, false);
  assert.equal(input.value, "C:\\work\\current");
  assert.deepEqual(input.events, []);
  assert.equal(input.focused, false);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "选择文件夹");
});

test("desktop initialization reveals each picker and routes native failures", async () => {
  const input = inputStub("/workspace");
  const button = buttonStub();
  const errors = [];
  const root = {
    querySelectorAll: () => [button],
    getElementById: (id) => id === "codex-workspace" ? input : null
  };

  const available = await initializeWorkspacePickers({
    root,
    createEvent,
    onError: (error) => errors.push(error.message),
    loadDialogs: async () => ({OpenFile: async () => { throw new Error("dialog failed"); }})
  });

  assert.equal(available, true);
  assert.equal(button.classList.hidden, false);
  await button.listeners.get("click")();
  assert.deepEqual(errors, ["dialog failed"]);
  assert.equal(input.value, "/workspace");
  assert.equal(button.disabled, false);
});

test("browser Console fallback keeps native picker controls hidden", async () => {
  const button = buttonStub();
  const root = {
    querySelectorAll: () => [button],
    getElementById: () => inputStub("/workspace")
  };

  const available = await initializeWorkspacePickers({
    root,
    loadDialogs: async () => { throw new Error("Wails runtime unavailable"); }
  });

  assert.equal(available, false);
  assert.equal(button.classList.hidden, true);
  assert.equal(button.listeners.size, 0);
});

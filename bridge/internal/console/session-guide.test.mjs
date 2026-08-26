import assert from "node:assert/strict";
import test from "node:test";

import { createSessionGuideController } from "./static/session-guide.mjs";

function focusableFixture() {
  return {
    focusCount: 0,
    focus() {
      this.focusCount += 1;
    }
  };
}

function dialogFixture({native = true} = {}) {
  const listeners = new Map();
  const dialog = {
    open: false,
    attributes: new Set(),
    addEventListener(name, listener) {
      listeners.set(name, listener);
    },
    hasAttribute(name) {
      return this.attributes.has(name);
    },
    setAttribute(name) {
      this.attributes.add(name);
      if (name === "open") this.open = true;
    },
    removeAttribute(name) {
      this.attributes.delete(name);
      if (name === "open") this.open = false;
    }
  };
  if (native) {
    dialog.showModal = function showModal() {
      this.open = true;
    };
    dialog.close = function close() {
      this.open = false;
      listeners.get("close")?.();
    };
  }
  dialog.dispatch = function dispatch(name, event = {}) {
    listeners.get(name)?.(event);
  };
  return dialog;
}

test("session guide opens modally and restores focus to its exact entry point", () => {
  const dialog = dialogFixture();
  const closeButton = focusableFixture();
  const opener = focusableFixture();
  const controller = createSessionGuideController(dialog, closeButton);

  controller.open(opener);
  assert.equal(dialog.open, true);
  assert.equal(closeButton.focusCount, 1);

  controller.close();
  assert.equal(dialog.open, false);
  assert.equal(opener.focusCount, 1);
});

test("session guide closes on Escape when the WebView omits native dialog cancellation", () => {
  const dialog = dialogFixture();
  const opener = focusableFixture();
  const controller = createSessionGuideController(dialog, focusableFixture());
  let prevented = false;

  controller.open(opener);
  dialog.dispatch("keydown", {
    key: "Escape",
    preventDefault() {
      prevented = true;
    }
  });

  assert.equal(prevented, true);
  assert.equal(dialog.open, false);
  assert.equal(opener.focusCount, 1);
});

test("session guide preserves open and focus behavior without native dialog methods", () => {
  const dialog = dialogFixture({native: false});
  const closeButton = focusableFixture();
  const opener = focusableFixture();
  const controller = createSessionGuideController(dialog, closeButton);

  controller.open(opener);
  assert.equal(dialog.hasAttribute("open"), true);
  controller.close();
  assert.equal(dialog.hasAttribute("open"), false);
  assert.equal(opener.focusCount, 1);
});

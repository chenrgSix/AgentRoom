export function createSessionGuideController(dialog, closeButton) {
  let opener = null;

  function restoreFocus() {
    const target = opener;
    opener = null;
    target?.focus?.();
  }

  function open(nextOpener) {
    if (dialog.open) return;
    opener = nextOpener || null;
    if (typeof dialog.showModal === "function") {
      dialog.showModal();
    } else {
      dialog.setAttribute("open", "");
    }
    closeButton.focus();
  }

  function close() {
    if (!dialog.open && !dialog.hasAttribute("open")) return;
    if (typeof dialog.close === "function") {
      dialog.close();
    } else {
      dialog.removeAttribute("open");
      restoreFocus();
    }
  }

  dialog.addEventListener("close", restoreFocus);
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    close();
  });

  return {open, close};
}

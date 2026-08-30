// Progressive enhancement only: every guide and code sample works without JS.
if (navigator.clipboard?.writeText) {
  for (const button of document.querySelectorAll("button[data-copy]")) {
    button.hidden = false;
    button.addEventListener("click", async () => {
      const target = document.getElementById(button.dataset.copy);
      const status = document.getElementById("copy-status");
      if (!target || !status) return;
      button.disabled = true;
      try {
        await navigator.clipboard.writeText(target.textContent.trim());
        status.textContent = "命令已复制。请在你自己的本地开发环境中按指南执行。";
        button.textContent = "已复制";
      } catch {
        status.textContent = "无法访问剪贴板，请选中并手动复制命令。";
        button.textContent = "请手动复制";
      } finally { button.disabled = false; }
    });
  }
}

import React, { useEffect, useRef, useState } from "react";
import type { ResultProjection, TaskProjection } from "@convene-wire/contracts/task-result";
import { captureWebSessionScope, jsonRequest } from "../../api-client.js";
import type { Locale } from "../../i18n.js";
import { resultReport } from "./result-report.js";

export function ResultReportActions({ taskId, resultId, locale, token }: {
  taskId: string; resultId: string; locale: Locale; token: string | undefined;
}) {
  const key = JSON.stringify([taskId, resultId, token, locale]);
  const current = useRef(key);
  current.current = key;
  const controller = useRef<AbortController | null>(null);
  const [status, setStatus] = useState<{ key: string; message: string; busy: boolean; failed: boolean } | null>(null);
  useEffect(() => () => { controller.current?.abort(); }, [key]);
  const t = (zh: string, en: string) => locale === "zh-CN" ? zh : en;
  async function deliver(kind: "copy" | "download") {
    if (controller.current && !controller.current.signal.aborted) return;
    const request = new AbortController();
    controller.current = request;
    const sessionValid = captureWebSessionScope();
    const valid = () => current.current === key && !request.signal.aborted && sessionValid();
    setStatus({ key, message: "", busy: true, failed: false });
    let stage = "read";
    try {
      // Rejoin current access and review facts before putting a report outside the UI.
      const [task, result] = await Promise.all([
        jsonRequest<TaskProjection>(`/api/tasks/${taskId}`, { signal: request.signal }, token),
        jsonRequest<ResultProjection>(`/api/results/${resultId}`, { signal: request.signal }, token)
      ]);
      if (!valid()) return;
      if (task.taskId !== taskId || result.resultId !== resultId) throw new Error("Report identity mismatch");
      const report = resultReport(task, result, locale, window.location.origin);
      stage = kind;
      if (kind === "copy") await navigator.clipboard.writeText(report);
      else {
        const url = URL.createObjectURL(new Blob([report], { type: "text/markdown;charset=utf-8" }));
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `TASK-${task.taskDisplayNumber}-Result-v${result.resultVersion}.md`;
        try { document.body.append(anchor); anchor.click(); }
        finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
      }
      if (valid()) setStatus({ key, busy: false, failed: false, message: kind === "copy" ? t("结果报告已复制。", "Result report copied.") : t("已开始下载结果报告。", "Result report download started.") });
    } catch {
      if (valid()) setStatus({ key, busy: false, failed: true, message: stage === "copy"
        ? t("无法访问剪贴板，请使用下载报告。", "Clipboard unavailable. Use Download report.")
        : stage === "download" ? t("下载未开始，请重试或复制结果。", "Download did not start. Retry or copy the report.")
        : t("无法读取当前结果，请刷新并确认仍有访问权限。", "Cannot read the current Result. Refresh and check your access.") });
    } finally { if (controller.current === request) controller.current = null; }
  }
  const visible = status?.key === key ? status : null;
  return <div className="result-report-actions">
    <button className="work-inline-link" disabled={visible?.busy} onClick={() => void deliver("copy")} type="button">{t("复制结果", "Copy Result")}</button>
    <button className="work-inline-link" disabled={visible?.busy} onClick={() => void deliver("download")} type="button">{t("下载报告", "Download report")}</button>
    {visible?.busy && <span role="status">{t("正在读取最新结果…", "Reading current Result…")}</span>}
    {visible?.message && <span role={visible.failed ? "alert" : "status"}>{visible.message}</span>}
  </div>;
}

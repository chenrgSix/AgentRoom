import type { Locale } from "../../i18n.js";
import { MarkdownMessage } from "../../MarkdownMessage.js";
import type { Run } from "../../models.js";
import type { RunActivityProjection } from "../../room-sync.js";
import type { RuntimeFailureCategory } from "../../run-diagnostics.js";

export function runStateLabel(state: Run["state"], locale: Locale): string {
  if (locale === "en") return state.replace("_", " ");
  const labels: Record<Run["state"], string> = {
    canceled: "已取消",
    completed: "已完成",
    delivered: "已投递",
    expired: "已过期",
    failed: "失败",
    input_required: "等待输入",
    outcome_unknown: "结果未知",
    queued: "排队中",
    working: "执行中"
  };
  return labels[state];
}

export function AgentRunActivity({
  projection,
  locale,
  active
}: {
  projection: RunActivityProjection | undefined;
  locale: Locale;
  active: boolean;
}) {
  if (!projection || projection.items.length === 0) return null;
  const items = [...projection.items].sort((left, right) =>
    left.sequence - right.sequence
  );
  const activeItem = [...items].reverse().find(({ phase }) =>
    phase === "started" || phase === "updated"
  );
  const summary = activeItem?.kind === "reasoning"
    ? (locale === "zh-CN" ? "正在思考" : "Thinking")
    : activeItem?.label
      ? (locale === "zh-CN" ? `正在使用 ${activeItem.label}` : `Using ${activeItem.label}`)
      : locale === "zh-CN"
        ? `${items.length} 项执行活动`
        : `${items.length} run activities`;
  return (
    <details
      className={`agent-run-activity${active ? " active" : ""}`}
      {...(active ? { open: true } : {})}
    >
      <summary>
        <span aria-hidden="true" className="agent-run-activity-pulse" />
        <strong>{summary}</strong>
        <span>{items.length}</span>
      </summary>
      <div className="agent-run-activity-body">
        {items.map((item) => (
          <section className={`agent-run-activity-item ${item.kind} ${item.phase}`} key={item.activityId}>
            <header>
              <strong>{item.kind === "reasoning"
                ? (locale === "zh-CN" ? "思考摘要" : "Reasoning summary")
                : item.label ?? (locale === "zh-CN" ? "工具" : "Tool")}</strong>
              <span>{item.phase === "started" || item.phase === "updated"
                ? (locale === "zh-CN" ? "进行中" : "Running")
                : item.phase === "failed"
                  ? (locale === "zh-CN" ? "失败" : "Failed")
                  : (locale === "zh-CN" ? "完成" : "Done")}</span>
            </header>
            {item.kind === "reasoning" && item.content && (
              <MarkdownMessage content={item.content} streaming={!projection.sealed} />
            )}
          </section>
        ))}
        <small>{locale === "zh-CN"
          ? "仅展示 Runtime 公开的思考摘要、工具名称和状态；命令、参数及本地输出保持私有。"
          : "Only public Runtime summaries, tool names, and status are shared; commands, arguments, and local output stay private."}</small>
      </div>
    </details>
  );
}

export function diagnosticCategoryLabel(
  category: RuntimeFailureCategory | null,
  locale: Locale
): string {
  if (!category) return locale === "zh-CN" ? "运行时" : "Runtime";
  if (locale === "en") return category.replace("_", " ");
  const labels: Record<RuntimeFailureCategory, string> = {
    start: "启动",
    authentication: "身份认证",
    rate_limit: "调用限流",
    network: "网络",
    model: "模型",
    configuration: "配置",
    unknown: "未知"
  };
  return labels[category];
}

export function diagnosticGuidance(
  category: RuntimeFailureCategory | null,
  locale: Locale
): string {
  if (locale === "en") {
    const guidance: Record<RuntimeFailureCategory, string> = {
      start: "Open Bridge and verify the Runtime executable.",
      authentication: "Sign in to the Runtime or refresh its API credential.",
      rate_limit: "Wait briefly, then retry the task.",
      network: "Check this device's network and provider access.",
      model: "Check the configured model and provider availability.",
      configuration: "Open Bridge, review the Runtime preset, then run its self-test.",
      unknown: "Export Bridge diagnostics if the retry also fails."
    };
    return guidance[category ?? "unknown"];
  }
  const guidance: Record<RuntimeFailureCategory, string> = {
    start: "请打开 Bridge，检查运行时程序是否可执行。",
    authentication: "请在本机重新登录运行时，或更新对应凭证。",
    rate_limit: "请稍等片刻后重试任务。",
    network: "请检查这台设备的网络和模型服务连接。",
    model: "请检查所选模型及其服务是否可用。",
    configuration: "请打开 Bridge 检查运行时预设，然后执行自检。",
    unknown: "若重试仍失败，请从 Bridge 导出诊断信息。"
  };
  return guidance[category ?? "unknown"];
}

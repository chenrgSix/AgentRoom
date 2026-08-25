import type { Locale } from "./i18n.js";

export function errorLabel(error: string, locale: Locale): string {
  if (locale === "en") return error;
  if (error.includes("Failed to fetch")) return "无法连接到主服务，请检查服务是否正在运行。";
  if (error.includes("Unexpected end of JSON input")) return "主服务返回了无效响应，请稍后重试。";
  const requestFailure = /Request failed \((\d+)\)/u.exec(error);
  if (requestFailure) return `请求失败（HTTP ${requestFailure[1]}）`;
  return `操作失败：${error}`;
}

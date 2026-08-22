const sensitivePatterns = [
  /bearer\s+[a-z0-9._~+/=-]{12,}/giu,
  /sk-[a-z0-9_-]{16,}/giu,
  /gh[pousr]_[a-z0-9]{20,}/giu,
  /AKIA[0-9A-Z]{16}/gu,
  /(password|secret|token)\s*[=:]\s*[^\s,;]{8,}/giu
];

export function redactSensitiveText(value: string): string {
  return sensitivePatterns.reduce(
    (redacted, pattern) => redacted.replace(pattern, "[REDACTED]"),
    value
  );
}

const canonicalBridgeVersionPattern =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;

export function normalizeBridgeVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.startsWith("v") ? value.slice(1) : value;
  return canonicalBridgeVersionPattern.test(normalized) ? normalized : undefined;
}

export function isCanonicalBridgeVersion(value: unknown): value is string {
  return typeof value === "string" &&
    canonicalBridgeVersionPattern.test(value);
}

export type EnvironmentSource = Record<string, string | undefined>;

export function renamedEnvironmentValue(
  env: EnvironmentSource,
  currentName: `CONVENE_WIRE_${string}`,
  legacyName: `AGENT_ROOM_${string}`
): string | undefined {
  const currentValue = env[currentName]?.trim() || undefined;
  const legacyValue = env[legacyName]?.trim() || undefined;

  if (
    currentValue !== undefined &&
    legacyValue !== undefined &&
    currentValue !== legacyValue
  ) {
    throw new Error(
      `${currentName} conflicts with legacy ${legacyName}; remove one value or make them identical`
    );
  }

  return currentValue ?? legacyValue;
}

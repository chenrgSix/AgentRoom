export interface MemorySummaryQualityFixture {
  expectedClaims: string[];
  forbiddenClaims: string[];
  requiredProvenanceMessageIds: string[];
}

export interface MemorySummaryQualityResult {
  claimRecall: number;
  falseClaimCount: number;
  provenanceRecall: number;
}

export function evaluateMemorySummaryQuality(
  summary: string,
  provenanceMessageIds: string[],
  fixture: MemorySummaryQualityFixture
): MemorySummaryQualityResult {
  const normalized = summary.toLocaleLowerCase();
  const recalled = fixture.expectedClaims.filter((claim) =>
    normalized.includes(claim.toLocaleLowerCase())
  ).length;
  const falseClaimCount = fixture.forbiddenClaims.filter((claim) =>
    normalized.includes(claim.toLocaleLowerCase())
  ).length;
  const provenance = new Set(provenanceMessageIds);
  const provenanceRecalled = fixture.requiredProvenanceMessageIds.filter(
    (messageId) => provenance.has(messageId)
  ).length;
  return {
    claimRecall: fixture.expectedClaims.length === 0
      ? 1
      : recalled / fixture.expectedClaims.length,
    falseClaimCount,
    provenanceRecall: fixture.requiredProvenanceMessageIds.length === 0
      ? 1
      : provenanceRecalled / fixture.requiredProvenanceMessageIds.length
  };
}

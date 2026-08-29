export interface BuildIdentity {
  releaseVersion: string;
  sourceCommit: string;
}

const developmentBuildIdentity: BuildIdentity = Object.freeze({
  releaseVersion: "development",
  sourceCommit: "unknown"
});

const releaseVersionPattern =
  /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const sourceCommitPattern = /^[0-9a-f]{40}$/u;

function normalized(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

export function resolveBuildIdentity(
  releaseVersionValue?: string,
  sourceCommitValue?: string
): BuildIdentity {
  const releaseVersion = normalized(releaseVersionValue);
  const sourceCommit = normalized(sourceCommitValue);

  if (releaseVersion === undefined && sourceCommit === undefined) {
    return developmentBuildIdentity;
  }
  if (releaseVersion === "development" && sourceCommit === "unknown") {
    return developmentBuildIdentity;
  }
  if (releaseVersion === undefined || sourceCommit === undefined) {
    throw new Error(
      "CONVENE_WIRE_RELEASE_VERSION and CONVENE_WIRE_SOURCE_COMMIT must be set together"
    );
  }
  if (!releaseVersionPattern.test(releaseVersion)) {
    throw new Error(
      "CONVENE_WIRE_RELEASE_VERSION must be a v-prefixed semantic version"
    );
  }
  if (!sourceCommitPattern.test(sourceCommit)) {
    throw new Error(
      "CONVENE_WIRE_SOURCE_COMMIT must be a 40-character lowercase Git commit"
    );
  }

  return { releaseVersion, sourceCommit };
}

export function defaultBuildIdentity(): BuildIdentity {
  return developmentBuildIdentity;
}

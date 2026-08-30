interface SensitiveTextRule {
  pattern: RegExp;
  markers: string[];
  openTail: RegExp;
}

const sensitiveRules: SensitiveTextRule[] = [
  {
    pattern: /bearer\s+[a-z0-9._~+/=-]{12,}/giu,
    markers: ["bearer"],
    openTail: /^bearer\s+[a-z0-9._~+/=-]*$/iu
  },
  {
    pattern: /sk-[a-z0-9_-]{16,}/giu,
    markers: ["sk-"],
    openTail: /^sk-[a-z0-9_-]*$/iu
  },
  {
    pattern: /gh[pousr]_[a-z0-9]{20,}/giu,
    markers: ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"],
    openTail: /^gh[pousr]_[a-z0-9]*$/iu
  },
  {
    pattern: /AKIA[0-9A-Z]{16}/gu,
    markers: ["AKIA"],
    openTail: /^AKIA[0-9A-Z]*$/u
  },
  {
    pattern: /(password|secret|token)\s*[=:]\s*[^\s,;]{8,}/giu,
    markers: ["password", "secret", "token"],
    openTail: /^(password|secret|token)\s*(?:[=:]\s*[^\s,;]*)?$/iu
  }
];

export function redactSensitiveText(value: string): string {
  return sensitiveRules.reduce(
    (redacted, rule) => redacted.replace(rule.pattern, "[REDACTED]"),
    value
  );
}

class SensitiveTextRedactionStage {
  readonly #pattern: RegExp;
  readonly #openTail: RegExp;
  readonly #markerPrefixes: RegExp;
  readonly #maximumMarkerLength: number;
  readonly #tailCandidate: RegExp;
  #pending = "";
  #candidateStart: number | undefined;

  public constructor(rule: SensitiveTextRule) {
    this.#pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    this.#openTail = rule.openTail;
    const prefixes = new Set(rule.markers.flatMap((marker) =>
      Array.from({ length: marker.length }, (_value, index) =>
        marker.slice(0, index + 1)
      )
    ));
    this.#markerPrefixes = new RegExp(
      `^(?:${[...prefixes].join("|")})$`,
      rule.openTail.flags
    );
    this.#maximumMarkerLength = Math.max(...rule.markers.map((marker) => marker.length));
    // The rule is anchored; remove its outer anchors for one suffix search.
    this.#tailCandidate = new RegExp(
      `(?:${rule.openTail.source.slice(1, -1)}|${[...prefixes].join("|")})$`,
      rule.openTail.flags
    );
  }

  public push(value: string): string {
    if (value.length === 0) return "";
    this.#pending += value;
    if (this.#candidateStart !== undefined) {
      // This suffix fenced the retained buffer and any overlapping match.
      // While it still extends, no retained prefix has become safe to emit.
      const retainedTail = this.#pending.slice(this.#candidateStart);
      if (
        this.#openTail.test(retainedTail) ||
        (retainedTail.length <= this.#maximumMarkerLength &&
          this.#markerPrefixes.test(retainedTail))
      ) return "";
    }
    // Search all suffix candidates in the regex engine instead of slicing and
    // testing each character of a retained secret again for every new delta.
    // Earlier starts already proved invalid cannot become valid by appending.
    const searchStart = this.#candidateStart ?? 0;
    const candidate = this.#tailCandidate.exec(this.#pending.slice(searchStart));
    const candidateStart = candidate ? searchStart + candidate.index : undefined;
    let tailStart = candidateStart ?? this.#pending.length;
    // A possible new marker can be inside an already complete match. Retain
    // the whole match so the chosen streaming boundary never reveals a prefix.
    if (candidateStart !== undefined && candidateStart > 0) {
      for (const match of this.#pending.matchAll(this.#pattern)) {
        if (match.index >= tailStart) break;
        if (match.index + match[0].length > tailStart) {
          tailStart = match.index;
          break;
        }
      }
    }
    const stable = this.#pending.slice(0, tailStart);
    this.#pending = this.#pending.slice(tailStart);
    this.#candidateStart = candidateStart === undefined ? undefined : candidateStart - tailStart;
    return stable.replace(this.#pattern, "[REDACTED]");
  }

  public finish(): string {
    const stable = this.#pending.replace(this.#pattern, "[REDACTED]");
    this.#pending = "";
    this.#candidateStart = undefined;
    return stable;
  }
}

export class StreamingSensitiveTextRedactor {
  // Run the same ordered replacement stages as redactSensitiveText. This also
  // keeps nested markers such as token=Bearer ... private across stage output.
  readonly #stages = sensitiveRules.map((rule) => new SensitiveTextRedactionStage(rule));

  public push(value: string): string {
    return this.#stages.reduce((text, stage) => stage.push(text), value);
  }

  public finish(): string {
    return this.#stages.reduce((text, stage) =>
      stage.push(text) + stage.finish(), ""
    );
  }
}

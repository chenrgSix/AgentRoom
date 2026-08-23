export class AnonymousRateLimitError extends Error {
  public constructor() {
    super("Too many anonymous authentication attempts");
    this.name = "AnonymousRateLimitError";
  }
}

interface RateEntry {
  count: number;
  windowStartedAt: number;
}

export class AnonymousRateLimiter {
  private readonly entries = new Map<string, RateEntry>();

  public constructor(
    private readonly maximumAttempts = 20,
    private readonly windowMilliseconds = 60_000,
    private readonly maximumEntries = 10_000
  ) {
    if (
      !Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1 ||
      !Number.isSafeInteger(windowMilliseconds) || windowMilliseconds < 1 ||
      !Number.isSafeInteger(maximumEntries) || maximumEntries < 1
    ) {
      throw new Error("Anonymous rate limit values must be positive integers");
    }
  }

  public consume(key: string, nowMilliseconds: number): void {
    const current = this.entries.get(key);
    if (
      !current ||
      nowMilliseconds - current.windowStartedAt >= this.windowMilliseconds
    ) {
      this.entries.set(key, { count: 1, windowStartedAt: nowMilliseconds });
      this.sweep(nowMilliseconds);
      return;
    }
    current.count += 1;
    if (current.count > this.maximumAttempts) {
      throw new AnonymousRateLimitError();
    }
  }

  private sweep(nowMilliseconds: number): void {
    if (this.entries.size <= this.maximumEntries) return;
    for (const [key, entry] of this.entries) {
      if (nowMilliseconds - entry.windowStartedAt >= this.windowMilliseconds) {
        this.entries.delete(key);
      }
    }
    while (this.entries.size > this.maximumEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }
}


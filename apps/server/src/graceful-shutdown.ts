export interface ShutdownSignalSource {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export function installGracefulShutdown(
  source: ShutdownSignalSource,
  close: () => Promise<unknown>,
  onError: (error: unknown) => void = () => undefined
): () => void {
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    void close().catch(onError).finally(() => {
      source.off("SIGINT", shutdown);
      source.off("SIGTERM", shutdown);
    });
  };
  source.on("SIGINT", shutdown);
  source.on("SIGTERM", shutdown);
  return () => {
    source.off("SIGINT", shutdown);
    source.off("SIGTERM", shutdown);
  };
}


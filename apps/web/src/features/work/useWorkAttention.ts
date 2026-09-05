import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkbenchPage } from "@convene-wire/contracts/task-result";
import { captureWebSessionScope, jsonRequest } from "../../api-client.js";
import type { LocalSession } from "../../models.js";

export const actionableReasons = ["needs_input", "needs_approval", "outcome_unknown"] as const;

/** One authorized item, not a count derived from a partially loaded page. */
export function useWorkAttention(teamId: string | null, session: LocalSession | null) {
  const key = JSON.stringify([teamId, session?.userId, session?.token]);
  const keyRef = useRef(key);
  keyRef.current = key;
  const request = useRef<{ key: string; controller: AbortController; done: Promise<void>; dirty: boolean } | null>(null);
  const [state, setState] = useState<{ key: string; item: WorkbenchPage["items"][number] | null; failed: boolean; loading: boolean } | null>(null);
  const token = session?.token;
  const userId = session?.userId;
  const refresh = useCallback(async () => {
    if (request.current?.key === key && !request.current.controller.signal.aborted) {
      request.current.dirty = true;
      return request.current.done;
    }
    request.current?.controller.abort();
    if (!teamId || !userId) { setState(null); return; }
    const controller = new AbortController();
    const sessionValid = captureWebSessionScope();
    const valid = () => keyRef.current === key && !controller.signal.aborted && sessionValid();
    setState((prior) => ({ key, item: prior?.key === key ? prior.item : null, failed: false, loading: true }));
    const pending = { key, controller, done: Promise.resolve(), dirty: false };
    request.current = pending;
    pending.done = (async () => {
      try {
        const query = new URLSearchParams({ scope: "mine", limit: "1", attention: actionableReasons.join(","), lifecycleState: "draft,ready,active,review" });
        do {
          pending.dirty = false;
          const page = await jsonRequest<WorkbenchPage>(`/api/teams/${teamId}/work-items?${query}`, { signal: controller.signal }, token);
          if (valid()) setState({ key, item: page.items[0] ?? null, failed: false, loading: false });
        } while (valid() && pending.dirty);
      } catch {
        if (valid()) setState({ key, item: null, failed: true, loading: false });
      } finally { if (request.current === pending) request.current = null; }
    })();
    return pending.done;
  }, [key, teamId, userId, token]);
  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => { request.current?.controller.abort(); window.removeEventListener("focus", onFocus); };
  }, [refresh]);
  const visible = state?.key === key && teamId && session ? state : null;
  return { item: visible?.item ?? null, failed: visible?.failed ?? false, loading: visible?.loading ?? false, refresh };
}

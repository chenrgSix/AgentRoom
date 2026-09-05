import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkbenchPage } from "@convene-wire/contracts/task-result";

import { jsonRequest } from "../../api-client.js";
import type { LocalSession } from "../../models.js";
import type { WorkFilters } from "./work-filters.js";

interface WorkbenchOptions extends WorkFilters {
  teamId: string | null;
  session: LocalSession | null;
  scope: "mine" | "team";
  lifecycleState: string;
  ownerMemberId: string;
  search?: string;
}

interface WorkbenchState {
  key: string;
  items: WorkbenchPage["items"];
  nextCursor: string | null;
  pages: number;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
}

function emptyState(key: string): WorkbenchState {
  return { key, items: [], nextCursor: null, pages: 1, loading: false, loadingMore: false, error: null };
}

function mergeItems(items: WorkbenchPage["items"]): WorkbenchPage["items"] {
  return [...new Map(items.map((item) => [item.taskId, item])).values()];
}

/** Owns only the visible page window, never an independent Task projection. */
export function useWorkbench({ teamId, session, scope, lifecycleState, ownerMemberId, search = "", attention = "", filterRoomId = "", filterAgentId = "", priority = "" }: WorkbenchOptions) {
  const userId = session?.userId ?? null;
  const token = session?.token;
  const normalizedSearch = search.trim();
  const key = JSON.stringify([teamId, userId, token, scope, lifecycleState, ownerMemberId, normalizedSearch, attention, filterRoomId, filterAgentId, priority]);
  const [state, setState] = useState<WorkbenchState>(() => emptyState(key));
  const stateRef = useRef(state);
  const keyRef = useRef(key);
  const requestRef = useRef({ sequence: 0, controller: null as AbortController | null });
  const pendingMoreRef = useRef<{ key: string; done: Promise<void> } | null>(null);
  stateRef.current = state;
  keyRef.current = key;

  const pathFor = useCallback((cursor?: string | null) => {
    const query = new URLSearchParams({ scope, limit: "100" });
    if (lifecycleState) query.set("lifecycleState", lifecycleState);
    if (ownerMemberId) query.set("ownerMemberId", ownerMemberId);
    if (normalizedSearch) query.set("search", normalizedSearch);
    if (attention) query.set("attention", attention);
    if (filterRoomId) query.set("roomId", filterRoomId);
    if (filterAgentId) query.set("agentId", filterAgentId);
    if (priority) query.set("priority", priority);
    if (cursor) query.set("cursor", cursor);
    return `/api/teams/${teamId}/work-items?${query}`;
  }, [teamId, scope, lifecycleState, ownerMemberId, normalizedSearch, attention, filterRoomId, filterAgentId, priority]);

  const refresh = useCallback(async () => {
    // A live notification must not silently cancel the page the user requested.
    // Context changes still abort immediately and never wait on another Team.
    const pendingMore = pendingMoreRef.current;
    if (pendingMore?.key === key) await pendingMore.done;
    if (keyRef.current !== key) return;
    requestRef.current.controller?.abort();
    const sequence = ++requestRef.current.sequence;
    if (!teamId || !userId) {
      requestRef.current.controller = null;
      setState(emptyState(key));
      return;
    }
    if ([...normalizedSearch].length > 100) {
      requestRef.current.controller = null;
      setState({ ...emptyState(key), error: "Search must be at most 100 characters." });
      return;
    }
    const controller = new AbortController();
    requestRef.current.controller = controller;
    const current = stateRef.current.key === key ? stateRef.current : emptyState(key);
    setState({ ...current, loading: true, loadingMore: false, error: null });
    const currentRequest = () => keyRef.current === key && requestRef.current.sequence === sequence;
    try {
      let items: WorkbenchPage["items"] = [];
      let cursor: string | null = null;
      let pages = 0;
      // Re-read the loaded window so live refresh neither hides older pages nor
      // retains Tasks which no longer satisfy current access or filters.
      do {
        const page: WorkbenchPage = await jsonRequest<WorkbenchPage>(pathFor(cursor), { signal: controller.signal }, token);
        if (!currentRequest()) return;
        items = [...items, ...page.items];
        cursor = page.nextCursor ?? null;
        pages += 1;
      } while (cursor && pages < current.pages);
      setState({ key, items: mergeItems(items), nextCursor: cursor, pages, loading: false, loadingMore: false, error: null });
    } catch (reason) {
      if (currentRequest()) setState((value) => ({ ...value, loading: false, error: String(reason) }));
    } finally {
      if (currentRequest()) requestRef.current.controller = null;
    }
  }, [key, teamId, userId, token, pathFor, normalizedSearch]);

  const loadMore = useCallback(async () => {
    const current = stateRef.current;
    if (current.key !== key || !current.nextCursor || current.loading ||
      current.loadingMore || requestRef.current.controller) return;
    const sequence = ++requestRef.current.sequence;
    const controller = new AbortController();
    requestRef.current.controller = controller;
    setState({ ...current, loadingMore: true, error: null });
    let finishMore!: () => void;
    const pending = { key, done: new Promise<void>((resolve) => { finishMore = resolve; }) };
    pendingMoreRef.current = pending;
    const currentRequest = () => keyRef.current === key && requestRef.current.sequence === sequence;
    try {
      const page = await jsonRequest<WorkbenchPage>(pathFor(current.nextCursor), { signal: controller.signal }, token);
      if (!currentRequest()) return;
      const updated: WorkbenchState = {
        ...current,
        items: mergeItems([...current.items, ...page.items]),
        nextCursor: page.nextCursor ?? null,
        pages: current.pages + 1,
        loadingMore: false,
        error: null
      };
      stateRef.current = updated;
      setState(updated);
    } catch (reason) {
      if (currentRequest()) setState((value) => ({ ...value, loadingMore: false, error: String(reason) }));
    } finally {
      if (currentRequest()) requestRef.current.controller = null;
      if (pendingMoreRef.current === pending) pendingMoreRef.current = null;
      finishMore();
    }
  }, [key, pathFor, token]);

  useEffect(() => {
    void refresh();
    return () => {
      ++requestRef.current.sequence;
      requestRef.current.controller?.abort();
      requestRef.current.controller = null;
    };
  }, [refresh]);

  const visible = state.key === key ? state : { ...emptyState(key), loading: Boolean(teamId && userId) };
  return { ...visible, hasMore: visible.nextCursor !== null, refresh, loadMore };
}

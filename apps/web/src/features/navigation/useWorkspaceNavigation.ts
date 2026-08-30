import { useCallback, useEffect, useRef, useState } from "react";
import { captureWebSessionScope, HttpRequestError, isStaleWebSessionError, jsonRequest } from "../../api-client.js";
import type { TaskProjection } from "@convene-wire/contracts/task-result";
import type { LocalSession, Room, Team } from "../../models.js";
import type { Locale } from "../../i18n.js";
import { parseWorkspaceNavigation, workspaceNavigationUrl, type WorkspaceNavigation } from "./workspace-navigation.js";

interface Options {
  session: LocalSession | null;
  ready: boolean;
  locale?: Locale;
  teams: Team[];
  snapshot: WorkspaceNavigation;
  onRestore: (navigation: WorkspaceNavigation) => void;
  onError: (message: string) => void;
}

/** URL intent is not authority: external navigation resolves against current access. */
export function useWorkspaceNavigation(options: Options) {
  const current = useRef(options);
  current.current = options;
  const request = useRef({ sequence: 0, controller: null as AbortController | null });
  const [restoring, setRestoring] = useState(false);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const { session, ready } = options;
  const label = (zh: string, en: string) => current.current.locale === "en" ? en : zh;

  useEffect(() => {
    if (!session || !ready) return;
    const validSession = captureWebSessionScope();
    const restore = async () => {
      request.current.controller?.abort();
      const sequence = ++request.current.sequence;
      const controller = new AbortController();
      request.current.controller = controller;
      const valid = () => validSession() && request.current.sequence === sequence && !controller.signal.aborted;
      const parsed = parseWorkspaceNavigation(window.location.search);
      setCopyStatus(null);
      if (!parsed.navigation && !parsed.error) {
        // Back to the clean entry point after an in-app history entry.
        current.current.onRestore({ teamId: current.current.teams[0]?.teamId, view: "work" });
        setRestoring(false);
        return;
      }
      setRestoring(true);
      try {
        if (parsed.error) throw new Error(label(parsed.error, "This link contains invalid navigation parameters."));
        const navigation = parsed.navigation!;
        const read = <T,>(path: string) => jsonRequest<T>(path, { signal: controller.signal }, session.token);
        const taskId = navigation.workTaskId ?? navigation.taskId;
        const task = taskId ? await read<TaskProjection>(`/api/tasks/${taskId}`) : null;
        if (!valid()) return;
        const team = current.current.teams.find(({ teamId }) => teamId === (navigation.teamId ?? task?.teamId ?? current.current.snapshot.teamId));
        if (!team) throw new Error(label("链接中的团队不可用或你没有访问权限。", "This Team is unavailable or you do not have access."));
        const rooms = await read<Room[]>(`/api/teams/${team.teamId}/rooms`);
        if (!valid()) return;
        let roomId = navigation.roomId;
        if (roomId && !rooms.some((room) => room.roomId === roomId)) {
          throw new Error(label("链接中的房间不可用或你没有访问权限。", "This Room is unavailable or you do not have access."));
        }
        if (task) {
          if (task.teamId !== team.teamId || (roomId && task.roomId !== roomId) || !rooms.some((room) => room.roomId === task.roomId)) {
            throw new Error(label("链接中的任务不属于当前可访问的团队和房间。", "This Task does not belong to the accessible Team and Room."));
          }
          roomId = task.roomId;
        }
        const resolved = { ...navigation, teamId: team.teamId, roomId: roomId ?? rooms[0]?.roomId };
        current.current.onRestore(resolved);
        window.history.replaceState(null, "", `${window.location.pathname}${workspaceNavigationUrl(resolved)}`);
      } catch (reason) {
        if (!valid() || isStaleWebSessionError(reason)) return;
        current.current.onError(reason instanceof Error && !(reason instanceof HttpRequestError)
          ? reason.message : label("无法恢复此链接，请确认资源仍存在且你有访问权限。", "Cannot restore this link. Check that the resource exists and you have access."));
        const fallback: WorkspaceNavigation = { teamId: current.current.teams[0]?.teamId, view: "work" };
        current.current.onRestore(fallback);
        window.history.replaceState(null, "", `${window.location.pathname}${workspaceNavigationUrl(fallback)}`);
      } finally {
        if (valid()) setRestoring(false);
      }
    };
    void restore();
    window.addEventListener("popstate", restore);
    return () => {
      ++request.current.sequence;
      request.current.controller?.abort();
      window.removeEventListener("popstate", restore);
    };
  }, [session, ready]);

  const navigate = useCallback((patch: Partial<WorkspaceNavigation>, replace = false) => {
    if (!current.current.session) return;
    ++request.current.sequence;
    request.current.controller?.abort();
    const next = { ...current.current.snapshot, ...patch };
    current.current = { ...current.current, snapshot: next };
    const url = `${window.location.pathname}${workspaceNavigationUrl(next)}`;
    if (url !== `${window.location.pathname}${window.location.search}`) {
      window.history[replace ? "replaceState" : "pushState"](null, "", url);
    }
    setRestoring(false);
    setCopyStatus(null);
    current.current.onRestore(next);
  }, []);

  const copyLink = useCallback(async () => {
    const valid = captureWebSessionScope();
    try {
      await navigator.clipboard.writeText(new URL(`${window.location.pathname}${workspaceNavigationUrl(current.current.snapshot)}`, window.location.origin).href);
      if (valid()) setCopyStatus(label("链接已复制；访问者仍需拥有该资源的权限。", "Link copied. Recipients still need access to this resource."));
    } catch {
      if (valid()) setCopyStatus(label("无法访问剪贴板，请复制浏览器地址栏中的链接。", "Clipboard unavailable. Copy the link from your browser address bar."));
    }
  }, []);
  return { navigate, copyLink, copyStatus, restoring };
}

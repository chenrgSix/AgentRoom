import { useCallback, useEffect, useMemo, useRef } from "react";
import { captureWebSessionScope } from "../../api-client.js";
import type { LocalSession } from "../../models.js";
import { RoomSynchronization, type RoomSynchronizationOptions } from "./room-synchronization.js";

interface Options extends Omit<RoomSynchronizationOptions, "teamId" | "roomId" | "session" | "isCurrentContext"> {
  teamId: string | null;
  roomId: string | null;
  session: LocalSession | null;
  onReset: () => void;
}

export function useRoomSynchronization(options: Options) {
  const { teamId, roomId, session } = options;
  const context = JSON.stringify([teamId, roomId, session?.userId, session?.token]);
  const lifetime = useMemo(() => ({
    controller: null as RoomSynchronization | null,
    isCurrentSession: captureWebSessionScope()
  }), [context, session]);
  const current = useRef({ lifetime, options });
  current.current = { lifetime, options };
  useEffect(() => {
    options.onReset();
    if (!teamId || !roomId || !session || !lifetime.isCurrentSession()) return;
    const active = new RoomSynchronization({
      teamId, roomId, session,
      isCurrentContext: () => current.current.lifetime === lifetime && lifetime.isCurrentSession(),
      onMessages: (messages) => current.current.options.onMessages(messages),
      onHistory: (history) => current.current.options.onHistory(history),
      onSnapshot: (snapshot) => current.current.options.onSnapshot(snapshot),
      onEvents: (runs, outputs) => current.current.options.onEvents(runs, outputs),
      loadOutputs: (runs) => current.current.options.loadOutputs(runs),
      refreshWorkbench: () => current.current.options.refreshWorkbench(),
      onError: (reason) => current.current.options.onError(reason)
    });
    lifetime.controller = active;
    void active.start();
    return () => {
      active.stop();
      if (lifetime.controller === active) lifetime.controller = null;
    };
  }, [lifetime]);

  const refresh = useCallback(async () => {
    const active = lifetime.controller;
    if (current.current.lifetime === lifetime && lifetime.isCurrentSession() && active?.isCurrent()) await active.refreshAfterAction();
  }, [lifetime]);
  const loadOlder = useCallback(async () => {
    const active = lifetime.controller;
    if (current.current.lifetime === lifetime && lifetime.isCurrentSession() && active?.isCurrent()) await active.loadOlder();
  }, [lifetime]);
  return { refresh, loadOlder };
}

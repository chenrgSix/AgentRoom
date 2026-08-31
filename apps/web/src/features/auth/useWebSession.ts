import { useCallback, useEffect, useRef, useState } from "react";
import { advanceWebSessionGeneration, webSessionExpiredEvent } from "../../api-client.js";
import type { AuthenticatedUser, AuthGateState, AuthMode, LocalSession } from "../../models.js";

/** Synchronous authority is independent of React's render/effect timing. */
export function useWebSession(onInvalidated: (previous: LocalSession) => void) {
  const [session, setSession] = useState<LocalSession | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode | null>(null);
  const [authState, setAuthState] = useState<AuthGateState>("loading");
  const authority = useRef<{ session: LocalSession | null; mode: AuthMode | null }>({ session: null, mode: null });
  const invalidated = useRef(onInvalidated);
  invalidated.current = onInvalidated;

  const activate = useCallback((user: AuthenticatedUser, mode: AuthMode, token?: string): LocalSession => {
    advanceWebSessionGeneration();
    const next = { userId: user.userId, displayName: user.displayName,
      ...(user.canManageOwnerRecovery === true ? { canManageOwnerRecovery: true } : {}),
      ...(token ? { token } : {}) };
    authority.current = { session: next, mode };
    setSession(next);
    setAuthMode(mode);
    setAuthState("authenticated");
    return next;
  }, []);

  const clear = useCallback(() => {
    const previous = authority.current;
    if (!previous.session) return;
    authority.current = { session: null, mode: previous.mode };
    advanceWebSessionGeneration();
    setSession(null);
    setAuthState(previous.mode === "local" ? "local_bootstrap" : "sign_in_required");
    invalidated.current(previous.session);
  }, []);

  useEffect(() => {
    window.addEventListener(webSessionExpiredEvent, clear);
    return () => window.removeEventListener(webSessionExpiredEvent, clear);
  }, [clear]);

  return { session, authMode, authState, setAuthMode, setAuthState, activate, clear };
}

import { useCallback, useEffect, useRef } from "react";
import { useFreeBird } from "../provider.js";

export interface UseSessionOptions {
  /** If true (default), automatically creates a session on mount. */
  autoCreate?: boolean;
  /** Optional topic used when auto-creating. */
  topic?: string;
  /** Optional tags applied to the auto-created session. */
  tags?: string[];
}

export interface UseSessionReturn {
  sessionId: string | null;
  createSession: (input?: { title?: string; topic?: string; tags?: string[] }) => Promise<string>;
  /** Swap to an existing session id (the host app is free to manage its own lookup). */
  setSessionId: (id: string) => void;
}

/**
 * Lightweight hook for managing the active chat session id. For most apps
 * the default (auto-create on mount) is what you want; apps with their own
 * chat list can provide `autoCreate: false` and call `setSessionId` manually.
 */
export const useSession = (opts: UseSessionOptions = {}): UseSessionReturn => {
  const fb = useFreeBird();
  const createdRef = useRef(false);

  const createSession = useCallback(
    async (input?: { title?: string; topic?: string; tags?: string[] }) => {
      const s = await fb.transport.createSession(
        input ?? { topic: opts.topic, tags: opts.tags },
      );
      /*
       * `openSession` rather than `setSessionId`: creating a session *is*
       * switching to one, and the conversation being left should not leak its
       * messages or half-finished action into the new one. At first mount
       * there is nothing to drop, so this costs nothing there.
       */
      fb.openSession(s.id);
      return s.id;
    },
    [fb, opts.topic, opts.tags],
  );

  useEffect(() => {
    if (fb.sessionId || opts.autoCreate === false || createdRef.current) return;
    createdRef.current = true;
    createSession().catch((err) => {
      console.error("[freebird] auto createSession failed:", err);
      createdRef.current = false;
    });
  }, [fb.sessionId, opts.autoCreate, createSession]);

  return {
    sessionId: fb.sessionId,
    createSession,
    setSessionId: fb.setSessionId,
  };
};

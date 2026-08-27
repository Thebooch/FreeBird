import { onMounted, type ComputedRef } from "vue";
import { useFreeBird } from "./useFreeBird.js";

export interface UseSessionOptions {
  /** If true (default), automatically creates a session on mount. */
  autoCreate?: boolean;
  topic?: string;
  tags?: string[];
}

export interface UseSessionReturn {
  sessionId: ComputedRef<string | null>;
  createSession: (input?: { title?: string; topic?: string; tags?: string[] }) => Promise<string>;
  setSessionId: (id: string) => void;
}

/**
 * Mirrors React's `useSession`. Creates a session on mount unless
 * `autoCreate: false` is passed. Guards against double-creation across
 * StrictMode-like re-renders using a per-store flag.
 */
const CREATED = new WeakSet<object>();

export const useSession = (opts: UseSessionOptions = {}): UseSessionReturn => {
  const fb = useFreeBird();

  const createSession = async (
    input?: { title?: string; topic?: string; tags?: string[] },
  ): Promise<string> => {
    const s = await fb.transport.createSession(
      input ?? { topic: opts.topic, tags: opts.tags },
    );
    fb.setSessionId(s.id);
    return s.id;
  };

  onMounted(() => {
    if (opts.autoCreate === false) return;
    if (fb.sessionId.value) return;
    if (CREATED.has(fb.store)) return;
    CREATED.add(fb.store);
    createSession().catch((err) => {
       
      console.error("[freebird] auto createSession failed:", err);
      CREATED.delete(fb.store);
    });
  });

  return {
    sessionId: fb.sessionId,
    createSession,
    setSessionId: (id) => fb.setSessionId(id),
  };
};

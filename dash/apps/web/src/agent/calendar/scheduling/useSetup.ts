import { ROLE_PERMISSIONS, type Principal } from "@freebirdai/dash-spec";
import { useCallback, useEffect, useState } from "react";
import { api, type SchedulingOverview } from "../../../api.js";
import { useScreenChanged } from "../../chatScreen.js";

const SETUP_SCREENS = ["types", "blocks", "people", "settings"] as const;

/**
 * Scheduling's setup, loaded once for a tab and loaded again after every
 * save, with who is looking and whether they may change it.
 */
export const useSetup = (): {
  readonly setup: SchedulingOverview | null;
  readonly error: string | null;
  readonly me: Principal | null;
  readonly canManage: boolean;
  readonly reload: () => Promise<void>;
} => {
  const [setup, setSetup] = useState<SchedulingOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [me, setMe] = useState<Principal | null>(null);

  const reload = useCallback(async () => {
    try {
      setSetup(await api.scheduling());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void reload();
    void api.me().then((who) => setMe(who.principal), () => undefined);
  }, [reload]);
  /* What the chat changes on these screens shows here at once. */
  useScreenChanged(SETUP_SCREENS, useCallback(() => void reload(), [reload]));

  return { setup, error, me, canManage: me ? ROLE_PERMISSIONS[me.role].includes("calendar.manage") : false, reload };
};

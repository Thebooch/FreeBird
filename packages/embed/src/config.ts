/**
 * Embed configuration, sourced from the bootstrap script tag:
 *
 *   <script src="https://cdn.freebird.dev/v1/freebird.js"
 *           data-site-id="fb_abc123"
 *           data-api="https://api.freebird.cloud"
 *           defer></script>
 *
 * Every attribute is optional. With no `data-site-id` the embed runs in
 * "self-hosted" mode: no handshake, no snapshot posting, chat straight against
 * `data-api` (default `/freebird`) — i.e. a plain `@freebirdai/server` mount.
 */
export interface EmbedConfig {
  /** Managed-backend site id (`fb_...`). Absent → self-hosted mode. */
  siteId?: string;
  /** API origin (managed) or path prefix (self-hosted). Default "". */
  api: string;
  /** Path suffix where FreeBird chat routes are mounted. Default "/freebird". */
  chatPath: string;
  /** Scan the DOM for data-freebird-* components. Default true. */
  autoScan: boolean;
  /** Post component snapshots to the backend. Default: true when siteId set. */
  snapshots: boolean;
  /**
   * Widget placement.
   * - "bottom-right"/"bottom-left": a floating launcher bubble with a popup panel.
   * - "full-right"/"full-left": a full-height sidebar that accordions in/out
   *   from the screen edge, with a slim edge tab when closed.
   */
  position: "bottom-right" | "bottom-left" | "full-right" | "full-left";
  /** Widget header title. */
  title: string;
  /** Input placeholder. */
  placeholder: string;
  /** Accent color override; otherwise CSS var / built-in default. */
  accent?: string;
  /**
   * Show a centered page overlay while actions run (navigation, form fill, etc.).
   * Hosts can also set `--freebird-overlay-accent` on `:root` for custom styling.
   */
  actionOverlay?: boolean;
}

export const DEFAULT_CONFIG: EmbedConfig = {
  api: "",
  chatPath: "/freebird",
  autoScan: true,
  snapshots: false,
  position: "bottom-right",
  title: "Chat with us",
  placeholder: "Ask a question…",
};

const parseBool = (v: string | null | undefined, fallback: boolean): boolean => {
  if (v == null || v === "") return fallback;
  return v !== "false" && v !== "off" && v !== "0";
};

const VALID_POSITIONS: readonly EmbedConfig["position"][] = [
  "bottom-right",
  "bottom-left",
  "full-right",
  "full-left",
];

const parsePosition = (v: string | null | undefined): EmbedConfig["position"] =>
  (VALID_POSITIONS as readonly string[]).includes(v ?? "")
    ? (v as EmbedConfig["position"])
    : DEFAULT_CONFIG.position;

/** Build a config from a script element's data attributes. */
export const configFromScript = (script: HTMLScriptElement): EmbedConfig => {
  const d = script.dataset;
  const siteId = d.siteId?.trim() || undefined;
  return {
    ...(siteId !== undefined ? { siteId } : {}),
    api: (d.api ?? DEFAULT_CONFIG.api).replace(/\/+$/, ""),
    chatPath: d.chatPath ?? DEFAULT_CONFIG.chatPath,
    autoScan: parseBool(d.scan, DEFAULT_CONFIG.autoScan),
    snapshots: parseBool(d.snapshots, siteId !== undefined),
    position: parsePosition(d.position),
    title: d.title ?? DEFAULT_CONFIG.title,
    placeholder: d.placeholder ?? DEFAULT_CONFIG.placeholder,
    ...(d.accent ? { accent: d.accent } : {}),
    // Managed sites (siteId set) enable the overlay by default — Studio and
    // other backends don't need a re-inject when the attribute is omitted.
    actionOverlay: parseBool(d.actionOverlay, siteId !== undefined),
  };
};

/** The chat transport base URL for a config. */
export const chatBaseUrl = (config: EmbedConfig): string =>
  `${config.api}${config.chatPath}`;

/**
 * Optional hooks passed to {@link start}. Not sourced from script attributes —
 * hosts wire framework integrations here (e.g. client-side router).
 */
export interface StartOptions {
  /**
   * Client-side navigation for cross-page local-dom actions. Return `true`
   * when the route change was handled without a full document load. Return
   * `false` to fall back to `location.assign`.
   */
  navigate?: (path: string) => void | boolean | Promise<void | boolean>;
}

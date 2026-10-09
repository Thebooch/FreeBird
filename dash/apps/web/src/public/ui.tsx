import { useEffect, type ReactNode } from "react";
import type { Brand } from "./api.js";
import { brandCss } from "./styles.js";

/* ── icons: one stroke set, drawn inline so the page loads nothing else ─── */

const PATHS = {
  calendar: "M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z",
  clock: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  pin: "M12 21s-7-5.5-7-11a7 7 0 1 1 14 0c0 5.5-7 11-7 11Zm0-8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  user: "M20 21a8 8 0 0 0-16 0M12 13a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
  check: "M5 12.5l4.5 4.5L19 7.5",
  x: "M6 6l12 12M18 6L6 18",
  alert: "M12 8v5M12 16.5v.5M10.3 3.9L2.6 17.3A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.7L13.7 3.9a2 2 0 0 0-3.4 0Z",
  info: "M12 11v6M12 7.5v.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  left: "M15 18l-6-6 6-6",
  right: "M9 18l6-6-6-6",
  globe: "M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3ZM21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  video: "M15 10l5-3v10l-5-3M4 6h11v12H4z",
  phone: "M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z",
  mail: "M4 6h16v12H4zM4 7l8 6 8-6",
  hourglass: "M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9s8 4 8 9",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3ZM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z",
  ban: "M5.6 5.6l12.8 12.8M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  lock: "M7 11V8a5 5 0 0 1 10 0v3M6 11h12v10H6z",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  edit: "M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4",
  note: "M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h5",
} as const;

export type IconName = keyof typeof PATHS;

export const Icon = ({ name, size = 18 }: { readonly name: IconName; readonly size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d={PATHS[name]} />
  </svg>
);

export const LOCATION_ICONS: Readonly<Record<string, IconName>> = { video: "video", phone: "phone", fixed: "pin", contact_address: "pin", ask: "pin" };

/* ── the frame ─────────────────────────────────────────────────────────── */

const BRAND_STYLE_ID = "pub-brand-style";

/** The workspace's color over the theme's accent, in its own element after the theme's. */
const useBrand = (brand: Brand | null) => {
  useEffect(() => {
    if (!brand) return;
    let element = document.getElementById(BRAND_STYLE_ID) as HTMLStyleElement | null;
    if (!element) {
      element = document.createElement("style");
      element.id = BRAND_STYLE_ID;
      document.head.appendChild(element);
    }
    element.textContent = brandCss(brand.accent);
    document.title = brand.name;
  }, [brand]);
};

export const Shell = ({
  brand,
  width,
  footer,
  children,
}: {
  readonly brand: Brand | null;
  readonly width?: "narrow";
  readonly footer?: ReactNode;
  readonly children: ReactNode;
}) => {
  useBrand(brand);
  const initial = (brand?.name.trim()[0] ?? "").toUpperCase();
  return (
    <div className="dash-root pub">
      <header className="pub-top">
        {brand ? (
          <span className="pub-brand">
            <span className="pub-brand__mark" aria-hidden="true">
              {initial || <Icon name="calendar" size={16} />}
            </span>
            {brand.name}
          </span>
        ) : (
          <span className="pub-skeleton" style={{ width: 160, height: 30 }} />
        )}
        <span className="pub-secure">
          <Icon name="lock" size={14} />
          <span>Private link</span>
        </span>
      </header>
      <main className="pub-main" data-width={width}>
        {children}
      </main>
      {footer ? <footer className="pub-foot">{footer}</footer> : null}
    </div>
  );
};

/* ── pieces ────────────────────────────────────────────────────────────── */

export const Button = ({
  children,
  tone,
  size,
  block,
  busy,
  disabled,
  type = "button",
  onClick,
}: {
  readonly children: ReactNode;
  readonly tone?: "primary" | "ghost" | "danger" | "danger-solid";
  readonly size?: "sm" | "lg";
  readonly block?: boolean;
  readonly busy?: boolean;
  readonly disabled?: boolean;
  readonly type?: "button" | "submit";
  readonly onClick?: () => void;
}) => (
  <button type={type} className="dash-btn" data-tone={tone} data-size={size} data-block={block ? "true" : undefined} disabled={disabled || busy} aria-busy={busy || undefined} onClick={onClick}>
    {busy ? <span className="dash-btn__spinner" aria-hidden="true" /> : null}
    {children}
  </button>
);

export const Field = ({
  label,
  optional,
  hint,
  error,
  htmlFor,
  children,
}: {
  readonly label: string;
  readonly optional?: boolean;
  readonly hint?: string;
  readonly error?: string;
  readonly htmlFor: string;
  readonly children: ReactNode;
}) => (
  <div className="pub-field">
    <label className="pub-field__label" htmlFor={htmlFor}>
      {label}
      {optional ? <em>Optional</em> : null}
    </label>
    {children}
    {error ? (
      <span className="pub-field__error" role="alert">
        {error}
      </span>
    ) : hint ? (
      <span className="pub-field__hint">{hint}</span>
    ) : null}
  </div>
);

export const Alert = ({ tone = "info", title, children }: { readonly tone?: "info" | "warn" | "danger" | "success"; readonly title?: string; readonly children?: ReactNode }) => (
  <div className="pub-alert" data-tone={tone} role={tone === "danger" ? "alert" : "status"}>
    <Icon name={tone === "success" ? "check" : tone === "info" ? "info" : "alert"} />
    <div>
      {title ? <strong>{title}</strong> : null}
      {children}
    </div>
  </div>
);

export const Loading = ({ label = "Loading" }: { readonly label?: string }) => (
  <div className="pub-center" role="status" aria-live="polite">
    <div className="pub-row">
      <span className="pub-spinner" aria-hidden="true" />
      <span className="pub-muted">{label}…</span>
    </div>
  </div>
);

/** A page that can't be shown: the link is wrong, spent or withdrawn. */
export const Unavailable = ({ title, message }: { readonly title: string; readonly message: string }) => (
  <div className="pub-card">
    <div className="pub-card__body">
      <div className="pub-status">
        <span className="pub-status__icon">
          <Icon name="ban" size={24} />
        </span>
        <h1 className="pub-title" data-size="sm">
          {title}
        </h1>
        <p className="pub-lead">{message}</p>
      </div>
    </div>
  </div>
);

export const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((one) => one[0]!.toUpperCase())
    .join("") || "?";

import { STATUS_ICONS, STATUS_TONES, type StatusTone } from "../palette.js";
import type { ReactNode } from "react";

/**
 * A small label. Chrome only — a badge never carries a series colour, because
 * a series colour means "this mark belongs to that entity" and a badge does
 * not belong to anything plotted.
 */
export type BadgeTone = "neutral" | "accent" | "warn" | "stale" | "danger";

export const Badge = ({
  children,
  tone = "neutral",
  title,
}: {
  readonly children: ReactNode;
  readonly tone?: BadgeTone;
  readonly title?: string;
}): JSX.Element => (
  <span className="dash-badge" data-tone={tone} {...(title ? { title } : {})}>
    {children}
  </span>
);

/**
 * A status, as icon plus label plus colour.
 *
 * Never colour alone: the icon survives a monochrome print and forced-colours
 * mode, and the word survives a reader who cannot tell the icons apart.
 */
export const StatusPill = ({
  tone,
  label,
}: {
  readonly tone: StatusTone;
  readonly label: string;
}): JSX.Element => (
  /*
   * The tone travels as an attribute, not only as an inline colour.
   *
   * It used to be a grey pill with one coloured glyph, which read as an
   * afterthought stuck to the end of a row. The attribute lets the stylesheet
   * tint the whole pill from the same reserved status palette, so a mark looks
   * like a mark — while the label stays present, because colour is never the
   * only channel carrying it.
   */
  <span className="dash-pill" data-tone={tone}>
    <span className="dash-pill__icon" style={{ color: STATUS_TONES[tone] }} aria-hidden="true">
      {STATUS_ICONS[tone]}
    </span>
    {label}
  </span>
);

/**
 * Initials in a circle.
 *
 * Deliberately monochrome. Colouring an avatar by hashing the name is the
 * usual move and it puts an arbitrary hue next to real data, where hue means
 * something — so the ring reads as decoration rather than as a category.
 */
export const Avatar = ({
  name,
  size = "md",
}: {
  readonly name: string;
  readonly size?: "sm" | "md";
}): JSX.Element => {
  const initials =
    name
      .split(/[\s._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "?";

  return (
    <span className="dash-avatar" data-size={size} title={name} aria-hidden="true">
      {initials}
    </span>
  );
};

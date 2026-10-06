import { AGENT_COLORS } from "@freebirdai/dash-spec";

/**
 * An agent's name with its colour: a dot and the words.
 *
 * Everything an agent does — a calendar entry, a finished task, a drafted
 * reply — wears this, so who did it reads at a glance. The colour is an index
 * into the series palette (`--dash-series-1..8`), not a hex, which is why it
 * reads on both surfaces without any contrast work of its own and recolours
 * with the theme. The dot is never the only channel: the name is always beside
 * it.
 */

/** The CSS custom property for an agent's colour index, clamped to the palette. */
export const agentColorVar = (color: number): string => {
  const index = Number.isFinite(color) ? Math.min(AGENT_COLORS, Math.max(1, Math.round(color))) : 1;
  return `var(--dash-series-${index})`;
};

export const AgentChip = ({
  name,
  color,
  size = "md",
  title,
}: {
  readonly name: string;
  /** 1–8, an agent's `color`. */
  readonly color: number;
  readonly size?: "sm" | "md";
  readonly title?: string;
}): JSX.Element => (
  <span className="dash-agent-chip" data-size={size} {...(title ? { title } : {})}>
    <span className="dash-agent-chip__dot" style={{ background: agentColorVar(color) }} aria-hidden="true" />
    <span className="dash-agent-chip__name">{name}</span>
  </span>
);

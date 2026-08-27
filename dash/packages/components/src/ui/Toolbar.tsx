import type { ReactNode } from "react";

/**
 * A row of controls above a component's content.
 *
 * `end` rather than a spacer element, so the caller cannot accidentally push
 * the wrong thing right, and so a customisation that hides one side leaves
 * the other where it was.
 */
export const Toolbar = ({
  children,
  end,
  testId,
}: {
  readonly children?: ReactNode;
  readonly end?: ReactNode;
  readonly testId?: string;
}): JSX.Element => (
  <div className="dash-toolbar" {...(testId ? { "data-testid": testId } : {})}>
    <div className="dash-toolbar__start">{children}</div>
    {end && <div className="dash-toolbar__end">{end}</div>}
  </div>
);

export const SectionHeader = ({
  title,
  meta,
  actions,
}: {
  readonly title: string;
  readonly meta?: string;
  readonly actions?: ReactNode;
}): JSX.Element => (
  <div className="dash-section-head">
    <h4 className="dash-section-head__title">{title}</h4>
    {meta && <span className="dash-section-head__meta">{meta}</span>}
    {actions && <span className="dash-section-head__actions">{actions}</span>}
  </div>
);

/** A keyboard shortcut, rendered as a key. */
export const Kbd = ({ children }: { readonly children: ReactNode }): JSX.Element => (
  <kbd className="dash-kbd">{children}</kbd>
);

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * The funnel every table has had since tables had filters.
 *
 * Drawn rather than typed: Unicode has no funnel, and the near misses are a
 * gear or a triangle — one reads as settings and the other as a sort. It sizes
 * itself from the button's font so it sits on the same line as the text glyphs
 * beside it.
 */
export const FilterGlyph = (): JSX.Element => (
  <svg
    viewBox="0 0 16 16"
    width="1em"
    height="1em"
    aria-hidden="true"
    focusable="false"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M2 3.5h12L9.5 8.6v4.2l-3 1.7V8.6L2 3.5Z" />
  </svg>
);

/**
 * An overflow menu.
 *
 * Hand-rolled rather than pulled in: a popover is a focus trap, an outside
 * click, an Escape handler and a keyboard walk, and every one of those is
 * about thirty lines. A dependency for this would cost more in bundle and
 * upgrade surface than it saves.
 */

export interface MenuItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: string;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  readonly tone?: "default" | "danger";
  /** Draws a rule above this item. */
  readonly separated?: boolean;
  /** Present makes this a checkbox item rather than a command. */
  readonly checked?: boolean;
  /** Keep the menu open after choosing. For a run of related toggles. */
  readonly keepOpen?: boolean;
  /**
   * The heading this item belongs under.
   *
   * Consecutive items sharing one become a labelled group, which is what lets
   * a filter menu say "Status" over its statuses and "Priority" over its
   * priorities instead of running thirty values together.
   */
  readonly section?: string;
  /** A figure drawn at the end of the row, such as how many rows match. */
  readonly meta?: string;
}

/** Items in order, with consecutive members of a section gathered up. */
const blocksOf = (
  items: readonly MenuItem[],
): readonly ({ kind: "loose"; item: MenuItem } | { kind: "group"; label: string; items: MenuItem[] })[] => {
  const blocks: ({ kind: "loose"; item: MenuItem } | { kind: "group"; label: string; items: MenuItem[] })[] = [];
  for (const item of items) {
    if (item.section === undefined) {
      blocks.push({ kind: "loose", item });
      continue;
    }
    const last = blocks[blocks.length - 1];
    if (last?.kind === "group" && last.label === item.section) last.items.push(item);
    else blocks.push({ kind: "group", label: item.section, items: [item] });
  }
  return blocks;
};

export const Menu = ({
  items,
  label = "More actions",
  glyph = "⋯",
  testId,
  badge,
}: {
  readonly items: readonly MenuItem[];
  readonly label?: string;
  /**
   * What the trigger draws. A string for the text glyphs the rest of the
   * chrome uses, or a node where a character will not do — Unicode has no
   * funnel, and a filter that opens from a gear reads as settings.
   */
  readonly glyph?: ReactNode;
  readonly testId?: string;
  /**
   * A count drawn on the trigger, for a menu whose state matters when it is
   * shut — a filter menu says how many filters are on without being opened.
   * Decorative: the same fact belongs in `label`, which is what is announced.
   */
  readonly badge?: number | undefined;
}): JSX.Element => {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const enabled = items.filter((item) => !item.disabled);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    // Focus goes back to the trigger on Escape or on choosing something, so a
    // keyboard user is not dropped at the top of the document.
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close(true);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setActive((previous) => {
          const step = event.key === "ArrowDown" ? 1 : -1;
          const next = previous + step;
          // Wraps, because a menu this short has no scroll to orient by.
          return next < 0 ? enabled.length - 1 : next >= enabled.length ? 0 : next;
        });
      }
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, close, enabled.length]);

  const renderItem = (item: MenuItem): JSX.Element => {
    const index = enabled.indexOf(item);
    return (
      <button
        key={item.id}
        type="button"
        role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
        aria-checked={item.checked}
        className="dash-menu__item"
        data-tone={item.tone ?? "default"}
        data-separated={item.separated ? "true" : undefined}
        data-active={index === active && index >= 0 ? "true" : undefined}
        disabled={item.disabled}
        onMouseEnter={() => index >= 0 && setActive(index)}
        onClick={() => {
          if (!item.keepOpen) close(true);
          item.onSelect();
        }}
        data-testid={`menu-item-${item.id}`}
      >
        {item.checked !== undefined ? (
          // A tick that reserves its space whether or not it is shown, so the
          // labels stay in one column as items toggle.
          <span className="dash-menu__icon" aria-hidden="true">
            {item.checked ? "✓" : ""}
          </span>
        ) : (
          item.icon && (
            <span className="dash-menu__icon" aria-hidden="true">
              {item.icon}
            </span>
          )
        )}
        <span className="dash-menu__label">{item.label}</span>
        {item.meta !== undefined && (
          <span className="dash-menu__meta" aria-hidden="true">
            {item.meta}
          </span>
        )}
      </button>
    );
  };

  return (
    <span className="dash-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="dash-iconbtn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        title={label}
        onClick={() => {
          setActive(0);
          setOpen((previous) => !previous);
        }}
        {...(testId ? { "data-testid": testId } : {})}
      >
        <span aria-hidden="true">{glyph}</span>
        {badge !== undefined && badge > 0 && (
          <span className="dash-menu__badge" aria-hidden="true">
            {badge}
          </span>
        )}
      </button>

      {open && (
        <div className="dash-menu__list" id={menuId} role="menu" aria-label={label}>
          {blocksOf(items).map((block) =>
            block.kind === "loose" ? (
              renderItem(block.item)
            ) : (
              /*
               * A real group rather than a heading floated above some rows:
               * the name has to be attached to the choices it governs, or a
               * reader arriving by keyboard is told "Completed" with nothing
               * saying completed *what*.
               */
              <div
                key={`section-${block.label}`}
                role="group"
                aria-label={block.label}
                className="dash-menu__group"
              >
                <span className="dash-menu__section" aria-hidden="true">
                  {block.label}
                </span>
                {block.items.map(renderItem)}
              </div>
            ),
          )}
        </div>
      )}
    </span>
  );
};

/** Rendered where a menu would be, when there is exactly one thing to do. */
export const MenuOrSingle = ({
  items,
  label,
  testId,
}: {
  readonly items: readonly MenuItem[];
  readonly label?: string;
  readonly testId?: string;
}): ReactNode => {
  if (items.length === 0) return null;
  if (items.length === 1) {
    const only = items[0]!;
    return (
      <button
        type="button"
        className="dash-iconbtn"
        title={only.label}
        aria-label={only.label}
        onClick={only.onSelect}
        disabled={only.disabled}
      >
        <span aria-hidden="true">{only.icon ?? "⋯"}</span>
      </button>
    );
  }
  return <Menu items={items} {...(label ? { label } : {})} {...(testId ? { testId } : {})} />;
};

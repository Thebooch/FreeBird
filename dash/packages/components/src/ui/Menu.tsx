import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

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
}

export const Menu = ({
  items,
  label = "More actions",
  glyph = "⋯",
  testId,
}: {
  readonly items: readonly MenuItem[];
  readonly label?: string;
  readonly glyph?: string;
  readonly testId?: string;
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
      </button>

      {open && (
        <div className="dash-menu__list" id={menuId} role="menu" aria-label={label}>
          {items.map((item) => {
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
                  // A tick that reserves its space whether or not it is shown,
                  // so the labels stay in one column as items toggle.
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
                {item.label}
              </button>
            );
          })}
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

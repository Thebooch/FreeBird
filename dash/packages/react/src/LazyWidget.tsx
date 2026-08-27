import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * Do not fetch what nobody has scrolled to yet.
 *
 * Every widget fires its request on mount, so a seventeen-widget board opens
 * by hitting someone else's API seventeen times — most of them for tiles below
 * the fold. On a metered or rate-limited API that is not a performance nicety,
 * it is spending the user's budget on things they have not looked at.
 *
 * The latch is deliberately one-way: once a widget has mounted it stays
 * mounted, because unmounting on scroll-away would throw the fetched rows
 * away and re-request them on the way back.
 */

/** How far ahead of the viewport a widget starts loading. */
const ROOT_MARGIN_PX = 400;

const nearViewport = (node: Element): boolean => {
  const rect = node.getBoundingClientRect();
  const height = window.innerHeight || document.documentElement.clientHeight;
  const width = window.innerWidth || document.documentElement.clientWidth;
  return (
    rect.top < height + ROOT_MARGIN_PX &&
    rect.bottom > -ROOT_MARGIN_PX &&
    rect.left < width + ROOT_MARGIN_PX &&
    rect.right > -ROOT_MARGIN_PX
  );
};

export const LazyWidget = ({
  children,
  /** Grid rows the cell spans, used to hold the space before mount. */
  minHeight,
  disabled,
}: {
  readonly children: ReactNode;
  readonly minHeight?: number;
  /** Skip deferral entirely — for tests, print, and server rendering. */
  readonly disabled?: boolean;
}): JSX.Element => {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(
    () => disabled === true || typeof IntersectionObserver === "undefined",
  );

  /**
   * Measure first, observe second.
   *
   * `IntersectionObserver` only delivers entries while the page is producing
   * frames, so a board in a background tab — or in any host that is not
   * compositing — can sit on placeholders indefinitely and never render at
   * all. A rect comes from layout, which happens regardless, so the tiles that
   * are already on screen mount without waiting for a frame. The observer then
   * only has to handle the ones that scroll into view later, which is exactly
   * the case it is good at.
   */
  useLayoutEffect(() => {
    if (shown) return;
    const node = ref.current;
    if (node && nearViewport(node)) setShown(true);
  }, [shown]);

  useEffect(() => {
    if (shown) return;
    const node = ref.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setShown(true);
        observer.disconnect();
      },
      { rootMargin: `${ROOT_MARGIN_PX}px` },
    );
    observer.observe(node);

    /*
     * A scroll listener as well, for the same reason as the measurement: if
     * frames are not being produced the observer stays quiet, and a widget the
     * user has deliberately scrolled to must appear regardless.
     */
    const recheck = (): void => {
      if (ref.current && nearViewport(ref.current)) setShown(true);
    };
    window.addEventListener("scroll", recheck, { passive: true, capture: true });
    window.addEventListener("resize", recheck, { passive: true });

    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", recheck, true);
      window.removeEventListener("resize", recheck);
    };
  }, [shown]);

  /*
   * The placeholder reserves the cell's real height. Without it the tile
   * collapses to nothing, everything below scrolls up into view at once, and
   * every widget mounts anyway — which is the opposite of the point.
   */
  return (
    <div className="dash-lazy" ref={ref} style={shown ? undefined : { minHeight }}>
      {shown ? children : <div className="dash-lazy__hold" aria-hidden="true" />}
    </div>
  );
};

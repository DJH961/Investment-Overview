import { useLayoutEffect, useRef, type RefObject } from "react";

/** Smallest scale the fit step may apply on top of the CSS container-query size. */
export const MIN_FIT = 0.55;

/**
 * Shrinks an element's font (via the `--kpi-tile-fit` custom property it reads) until its
 * content fits its width. CSS already sizes the figure from the container width; this
 * catches the long ones ("-$12,345,678.90" in a 2-column phone grid, a seven-figure hero).
 *
 * Cheap on live ticks: the ResizeObserver is created once, and the layout reads only run
 * when the rendered text or the width actually changed.
 */
export function useFitWidth(ref: RefObject<HTMLElement | null>, loading: boolean) {
  const lastText = useRef<string | null>(null);
  const fitRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      fitRef.current = null;
      return;
    }
    const fit = () => {
      el.style.setProperty("--kpi-tile-fit", "1");
      const avail = el.clientWidth;
      const need = el.scrollWidth;
      if (avail > 0 && need > avail) {
        const scale = Math.max(MIN_FIT, Math.floor((avail / need) * 100) / 100);
        el.style.setProperty("--kpi-tile-fit", String(scale));
      }
    };
    fitRef.current = fit;
    lastText.current = el.textContent ?? "";
    fit();
    if (typeof ResizeObserver === "undefined") return;
    let last = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== last) {
        last = el.clientWidth;
        fit();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, loading]);

  // Every render: a string compare only; the layout work happens when the text changed.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !fitRef.current) return;
    const text = el.textContent ?? "";
    if (text !== lastText.current) {
      lastText.current = text;
      fitRef.current();
    }
  });
}

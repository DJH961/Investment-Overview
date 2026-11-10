import clsx from "clsx";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useHideAmounts } from "../../lib/hideAmounts";
import "./Treemap.scss";

export interface TreemapItem {
  id: string;
  label: string;
  /** Area weight (typically market value); must be > 0 to be drawn. */
  value: number;
  /** Optional colour tone, e.g. by return sign. */
  tone?: "pos" | "neg" | "neutral";
  /** Secondary text shown under the label when it fits. */
  detail?: string;
}

export interface TreemapRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Squarified treemap layout (Bruls et al.). Rects tile exactly w*h. */
export function squarify(items: { id: string; value: number }[], w: number, h: number): TreemapRect[] {
  const list = items.filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  const total = list.reduce((a, i) => a + i.value, 0);
  if (!list.length || w <= 0 || h <= 0) return [];
  const scaled = list.map((i) => ({
    id: i.id,
    area: (i.value / total) * w * h,
  }));
  const out: TreemapRect[] = [];
  let x = 0;
  let y = 0;
  let rw = w;
  let rh = h;

  const worst = (row: number[], side: number) => {
    const s = row.reduce((a, b) => a + b, 0);
    const max = Math.max(...row);
    const min = Math.min(...row);
    return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
  };

  let i = 0;
  while (i < scaled.length) {
    const side = Math.min(rw, rh);
    let end = i + 1;
    let row = [scaled[i].area];
    while (end < scaled.length && worst([...row, scaled[end].area], side) <= worst(row, side)) {
      row = [...row, scaled[end].area];
      end++;
    }
    const sum = row.reduce((a, b) => a + b, 0);
    if (rw >= rh) {
      // lay the row out as a column on the left
      const colW = sum / rh;
      let cy = y;
      for (let k = i; k < end; k++) {
        const ch = scaled[k].area / colW;
        out.push({ id: scaled[k].id, x, y: cy, w: colW, h: ch });
        cy += ch;
      }
      x += colW;
      rw -= colW;
    } else {
      const rowH = sum / rw;
      let cx = x;
      for (let k = i; k < end; k++) {
        const cw = scaled[k].area / rowH;
        out.push({ id: scaled[k].id, x: cx, y, w: cw, h: rowH });
        cx += cw;
      }
      y += rowH;
      rh -= rowH;
    }
    i = end;
  }
  return out;
}

export interface TreemapProps {
  items: TreemapItem[];
  height?: number;
  /** Formats the value shown in labels and tooltip. */
  valueFormat?: (v: number) => string;
  /** Names an item's `detail` in the tooltip (e.g. "Today" for "+1.2%"), so the
   * percentage printed on a tile and the one in the tooltip are never confused. */
  detailLabel?: string;
  ariaLabel?: string;
  className?: string;
  /** Makes the tiles real buttons (for example open the holding). Without it they are
   * not tab stops: their name and figures are already in each tile's aria-label. */
  onSelect?: (id: string) => void;
}

export function Treemap({
  items,
  height = 280,
  valueFormat = (v) => String(v),
  detailLabel,
  ariaLabel = "Treemap",
  className,
  onSelect,
}: TreemapProps) {
  const ref = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLOutputElement>(null);
  // Measured before the first paint (no fake-600 px first frame, then a jump).
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<string | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w0 = el.getBoundingClientRect().width;
    setWidth(w0 > 0 ? w0 : 600);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A tap keeps the tooltip open (touch fires pointerleave at once); the next tap elsewhere closes it.
  useEffect(() => {
    if (!hover) return;
    const close = (e: globalThis.PointerEvent) => {
      const cell = (e.target as Element | null)?.closest?.("[data-treemap-id]");
      if (!cell || cell.getAttribute("data-treemap-id") !== hover || !ref.current?.contains(cell)) setHover(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [hover]);

  const rectsRef = useRef<ReturnType<typeof squarify>>([]);
  // Keep the tooltip inside the treemap box: measured, then clamped on both axes.
  useLayoutEffect(() => {
    const tip = tipRef.current;
    if (!tip || !hover) return;
    const r = rectsRef.current.find((x) => x.id === hover);
    if (!r) return;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    tip.style.left = `${Math.min(Math.max(r.x + r.w / 2, tw / 2), Math.max(tw / 2, width - tw / 2))}px`;
    tip.style.top = `${Math.min(Math.max(r.y + r.h / 2, th / 2), Math.max(th / 2, height - th / 2))}px`;
  });

  const { hide } = useHideAmounts();
  const rects = width > 0 ? squarify(items, width, height) : [];
  useEffect(() => {
    rectsRef.current = rects;
  });
  const byId = new Map(items.map((i) => [i.id, i]));
  const total = items.reduce((a, i) => a + Math.max(i.value, 0), 0);
  const share = (v: number) => `${((v / total) * 100).toFixed(1)}%`;
  const named = (detail: string) => (detailLabel ? `${detailLabel} ${detail}` : detail);
  const active = hover ? rects.find((r) => r.id === hover) : undefined;
  const activeItem = active ? byId.get(active.id) : undefined;

  return (
    <figure className={clsx("treemap", className)} ref={ref} style={{ height }} aria-label={ariaLabel}>
      {rects.map((r) => {
        const item = byId.get(r.id);
        if (!item) return null;
        // Small tiles (common on a phone) still get their name, in a compact type
        // size with an ellipsis; only a sliver too thin for any text stays blank
        // (its name is in the tooltip on tap / hover and in its aria-label).
        const compact = r.w < 90 || r.h < 48;
        const fitsLabel = r.w > 28 && r.h > 18;
        const fitsDetail = compact ? r.w > 48 && r.h > 34 : true;
        return (
          <button
            type="button"
            key={r.id}
            className={clsx(
              "treemap__cell",
              `treemap__cell--${item.tone ?? "neutral"}`,
              compact && "treemap__cell--compact",
            )}
            data-testid={`cell-${r.id}`}
            style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
            aria-label={[
              item.label,
              ...(hide ? [] : [valueFormat(item.value)]),
              `${share(item.value)} of total`,
              ...(item.detail ? [named(item.detail)] : []),
            ].join(", ")}
            data-treemap-id={r.id}
            role={onSelect ? undefined : "img"}
            tabIndex={onSelect ? undefined : -1}
            onClick={onSelect ? () => onSelect(r.id) : undefined}
            onPointerEnter={() => setHover(r.id)}
            onPointerDown={() => setHover(r.id)}
            onPointerLeave={(e) => {
              if (e.pointerType !== "touch") setHover(null);
            }}
            onFocus={() => setHover(r.id)}
            onBlur={() => setHover(null)}
          >
            {fitsLabel && (
              <span className="treemap__label">
                <span className="treemap__name">{item.label}</span>
                {fitsDetail && <span className="treemap__detail">{hide ? share(item.value) : (item.detail ?? valueFormat(item.value))}</span>}
              </span>
            )}
          </button>
        );
      })}
      {active && activeItem && (
        <output
          ref={tipRef}
          className="treemap__tooltip"
          style={{
            left: Math.min(Math.max(active.x + active.w / 2, 70), width - 70),
            top: active.y + active.h / 2,
          }}
        >
          <strong>{activeItem.label}</strong>
          {!hide && <span>{valueFormat(activeItem.value)}</span>}
          <span className="treemap__share">{share(activeItem.value)} of total</span>
          {activeItem.detail && <span className="treemap__share">{named(activeItem.detail)}</span>}
        </output>
      )}
    </figure>
  );
}

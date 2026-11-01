import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
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
  ariaLabel?: string;
  className?: string;
}

export function Treemap({
  items,
  height = 280,
  valueFormat = (v) => String(v),
  ariaLabel = "Treemap",
  className,
}: TreemapProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rects = squarify(items, width, height);
  const byId = new Map(items.map((i) => [i.id, i]));
  const total = items.reduce((a, i) => a + Math.max(i.value, 0), 0);
  const active = hover ? rects.find((r) => r.id === hover) : undefined;
  const activeItem = active ? byId.get(active.id) : undefined;

  return (
    <figure className={clsx("treemap", className)} ref={ref} style={{ height }} aria-label={ariaLabel}>
      {rects.map((r) => {
        const item = byId.get(r.id);
        if (!item) return null;
        const fitsLabel = r.w > 56 && r.h > 28;
        const fitsDetail = r.w > 90 && r.h > 48;
        return (
          <button
            type="button"
            key={r.id}
            className={clsx("treemap__cell", `treemap__cell--${item.tone ?? "neutral"}`)}
            data-testid={`cell-${r.id}`}
            style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
            aria-label={`${item.label}, ${valueFormat(item.value)}, ${((item.value / total) * 100).toFixed(1)}%`}
            onPointerEnter={() => setHover(r.id)}
            onPointerLeave={() => setHover(null)}
            onFocus={() => setHover(r.id)}
            onBlur={() => setHover(null)}
          >
            {fitsLabel && (
              <span className="treemap__label">
                <span className="treemap__name">{item.label}</span>
                {fitsDetail && <span className="treemap__detail">{item.detail ?? valueFormat(item.value)}</span>}
              </span>
            )}
          </button>
        );
      })}
      {active && activeItem && (
        <output
          className="treemap__tooltip"
          style={{
            left: Math.min(Math.max(active.x + active.w / 2, 70), width - 70),
            top: active.y + active.h / 2,
          }}
        >
          <strong>{activeItem.label}</strong>
          <span>{valueFormat(activeItem.value)}</span>
          <span className="treemap__share">{((activeItem.value / total) * 100).toFixed(1)}%</span>
        </output>
      )}
    </figure>
  );
}

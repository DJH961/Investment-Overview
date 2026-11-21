import clsx from "clsx";
import { useEffect, useRef, useState, type ReactNode } from "react";
import "./SectionBar.scss";

export interface SectionBarItem {
  id: string;
  label: string;
}

export interface SectionBarProps {
  items: SectionBarItem[];
  /** Accessible name ("Currency sections"). */
  label: string;
  /** Called before the jump, so a page can mount a section that has not loaded yet. */
  onSelect?: (id: string) => void;
  /** Quiet text at the right end (the range the sections describe). */
  extra?: ReactNode;
  className?: string;
}

/** Pixels under the top of the viewport that count as "here" (top bar + this bar + a little). */
function spyLine(bar: HTMLElement | null): number {
  const rect = bar?.getBoundingClientRect();
  return (rect ? rect.bottom : 120) + 24;
}

/**
 * A sticky row of section chips (v7.2: the Currency page). A chip scrolls to its
 * section; the chip of the section you are reading is highlighted. Above the first
 * section nothing is highlighted: you are not in one yet.
 */
export function SectionBar({ items, label, onSelect, extra, className }: SectionBarProps) {
  const ref = useRef<HTMLElement | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const ids = items.map((i) => i.id).join(",");

  useEffect(() => {
    if (typeof window === "undefined") return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = spyLine(ref.current);
      let here: string | null = null;
      for (const id of ids.split(",")) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= line) here = id;
      }
      // At the very bottom the last section is "here" even when it is too short to reach the line.
      const doc = document.documentElement;
      if (here && window.innerHeight + window.scrollY >= doc.scrollHeight - 2) here = ids.split(",").at(-1) ?? here;
      setActive(here);
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [ids]);

  function jump(id: string) {
    onSelect?.(id);
    // After the page has mounted the section (one frame), so the jump lands on its title.
    window.requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (!el) return;
      const smooth = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      if (typeof el.scrollIntoView === "function") el.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
      try {
        window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}#${id}`);
      } catch {
        /* sandboxed: the jump still happens */
      }
    });
  }

  return (
    <nav ref={ref} className={clsx("section-bar", className)} aria-label={label}>
      <ul className="section-bar__list" data-scrollable>
        {items.map((item) => (
          <li key={item.id} className="section-bar__item">
            <a
              href={`#${item.id}`}
              className={clsx("section-bar__link", active === item.id && "section-bar__link--active")}
              aria-current={active === item.id ? "location" : undefined}
              onClick={(e) => {
                e.preventDefault();
                jump(item.id);
              }}
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
      {extra ? <span className="section-bar__extra">{extra}</span> : null}
    </nav>
  );
}

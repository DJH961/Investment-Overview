import clsx from "clsx";
import { Tabs as RadixTabs } from "radix-ui";
import { useEffect, useRef, type ReactNode } from "react";
import "./Tabs.scss";

export interface TabItem<T extends string> {
  value: T;
  label: string;
  /** Optional count or short note after the label ("12"). */
  badge?: ReactNode;
  content: ReactNode;
}

export interface TabsProps<T extends string> {
  items: TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
  /** Phone: share the row without scrolling (badges hidden). For four short tabs. */
  fit?: boolean;
}

/**
 * Underlined page tabs (v7: the holding page's Details / Transactions / Dividends).
 * For switching between views of one figure use the SegmentedControl instead; tabs
 * switch between whole panels. On a phone the tab row scrolls sideways when it must.
 * Controlled, so a page can mirror the tab in the URL.
 */
export function Tabs<T extends string>({ items, value, onChange, ariaLabel, className, fit = false }: TabsProps<T>) {
  const listRef = useRef<HTMLDivElement | null>(null);
  // A row that scrolls sideways keeps the open tab in view (a deep link to the last tab).
  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[data-state="active"]');
    if (active && typeof active.scrollIntoView === "function") active.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [value]);
  return (
    <RadixTabs.Root className={clsx("tabs", fit && "tabs--fit", className)} value={value} onValueChange={(v) => onChange(v as T)}>
      <RadixTabs.List ref={listRef} className="tabs__list" aria-label={ariaLabel} data-scrollable>
        {items.map((item) => (
          <RadixTabs.Trigger key={item.value} value={item.value} className="tabs__trigger">
            <span className="tabs__label">{item.label}</span>
            {item.badge != null && <span className="tabs__badge">{item.badge}</span>}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {items.map((item) => (
        <RadixTabs.Content key={item.value} value={item.value} className="tabs__panel">
          {item.content}
        </RadixTabs.Content>
      ))}
    </RadixTabs.Root>
  );
}

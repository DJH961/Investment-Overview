import {
  ArrowLeftRight,
  Banknote,
  CalendarRange,
  CircleHelp,
  HeartPulse,
  LayoutDashboard,
  Calculator,
  PieChart,
  Receipt,
  Settings,
  Tags,
  ShieldAlert,
  Upload,
  Wallet,
  type LucideIcon,
} from "lucide-react";

export type NavGroup = "Portfolio" | "Manage" | "System";

export interface NavItem {
  to: string;
  label: string;
  /** Top-bar title when the label is too long for a phone (default: label). */
  short?: string;
  icon: LucideIcon;
  group: NavGroup;
  /** Shown as a bottom tab on phones (the rest go into the More sheet). */
  tab?: boolean;
  /** Two-key shortcut after "g". */
  shortcut?: string;
}

export const NAV_ITEMS: NavItem[] = [
  { to: "/overview", label: "Overview", icon: LayoutDashboard, group: "Portfolio", tab: true, shortcut: "o" },
  { to: "/holdings", label: "Holdings", icon: Wallet, group: "Portfolio", tab: true, shortcut: "h" },
  { to: "/periods", label: "Periods", icon: CalendarRange, group: "Portfolio", tab: true, shortcut: "p" },
  { to: "/activity", label: "Activity", icon: Banknote, group: "Portfolio", shortcut: "a" },
  { to: "/risk", label: "Risk & analytics", icon: ShieldAlert, group: "Portfolio", shortcut: "r" },
  { to: "/projection", label: "Projection", icon: Calculator, group: "Portfolio", shortcut: "c" },
  { to: "/transactions", label: "Transactions", icon: Receipt, group: "Manage", tab: true, shortcut: "t" },
  { to: "/import", label: "Import", icon: Upload, group: "Manage", shortcut: "i" },
  { to: "/instruments", label: "Instruments", icon: Tags, group: "Manage" },
  { to: "/conversions", label: "Currency conversions", short: "Conversions", icon: ArrowLeftRight, group: "Manage" },
  { to: "/allocations", label: "Allocations", icon: PieChart, group: "Manage", shortcut: "l" },
  { to: "/diagnostics", label: "Health & Repair", icon: HeartPulse, group: "System", shortcut: "d" },
  { to: "/settings", label: "Settings", icon: Settings, group: "System", shortcut: "s" },
  { to: "/help", label: "Help", icon: CircleHelp, group: "System" },
];

export const NAV_GROUPS: NavGroup[] = ["Portfolio", "Manage", "System"];

/** Phone bottom tabs (owner decision: Overview, Holdings, Periods, Transactions + More). */
export const TAB_ITEMS: NavItem[] = NAV_ITEMS.filter((i) => i.tab);

/** The More sheet: everything that is not a tab, grouped, most-used first within each group. */
export function moreSections(): { group: NavGroup; items: NavItem[] }[] {
  return NAV_GROUPS.map((group) => ({ group, items: NAV_ITEMS.filter((i) => !i.tab && i.group === group) })).filter(
    (s) => s.items.length > 0,
  );
}

export function titleFor(pathname: string): string {
  const item = NAV_ITEMS.find((i) => pathname === i.to || pathname.startsWith(`${i.to}/`));
  return item ? (item.short ?? item.label) : "Investment Overview";
}

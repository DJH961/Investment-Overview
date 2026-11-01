import {
  ArrowLeftRight,
  Banknote,
  CalendarRange,
  CircleHelp,
  Coins,
  HeartPulse,
  LayoutDashboard,
  Calculator,
  PieChart,
  Receipt,
  Settings,
  ShieldAlert,
  Upload,
  Wallet,
  type LucideIcon,
} from "lucide-react";

export type NavGroup = "Portfolio" | "Manage" | "System";

export interface NavItem {
  to: string;
  label: string;
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
  { to: "/activity", label: "Activity", icon: Banknote, group: "Portfolio", tab: true, shortcut: "a" },
  { to: "/risk", label: "Risk & analytics", icon: ShieldAlert, group: "Portfolio", shortcut: "r" },
  { to: "/projection", label: "Projection & calculator", icon: Calculator, group: "Portfolio", shortcut: "c" },
  { to: "/transactions", label: "Transactions", icon: Receipt, group: "Manage", shortcut: "t" },
  { to: "/import", label: "Import", icon: Upload, group: "Manage", shortcut: "i" },
  { to: "/conversions", label: "Currency conversions", icon: ArrowLeftRight, group: "Manage" },
  { to: "/allocations", label: "Allocations", icon: PieChart, group: "Manage", shortcut: "l" },
  { to: "/diagnostics", label: "Data health", icon: HeartPulse, group: "System", shortcut: "d" },
  { to: "/settings", label: "Settings", icon: Settings, group: "System", shortcut: "s" },
  { to: "/help", label: "Help", icon: CircleHelp, group: "System" },
];

export const NAV_GROUPS: NavGroup[] = ["Portfolio", "Manage", "System"];

export const BRAND_ICON = Coins;

export function titleFor(pathname: string): string {
  return NAV_ITEMS.find((i) => pathname === i.to || pathname.startsWith(`${i.to}/`))?.label ?? "Investment Overview";
}

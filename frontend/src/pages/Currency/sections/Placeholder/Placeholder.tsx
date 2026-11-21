import { CurrencySection } from "../../../../components/CurrencySection";
import type { CurrencySectionComponentProps } from "../../sections";

/**
 * Holds a registry slot until its section lands (the other 7.2 lane replaces these
 * entries in `sections.ts`). Shows the shell's calm empty state, never fake figures.
 */
export function PlaceholderSection({ id, label }: CurrencySectionComponentProps) {
  return <CurrencySection id={id} title={label} state="empty" emptyTitle="Coming soon" />;
}

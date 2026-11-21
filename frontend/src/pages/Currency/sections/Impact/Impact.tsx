import { CurrencySection } from "../../../../components/CurrencySection";
import type { CurrencySectionComponentProps } from "../../sections";

/** Impact: what the currency did to you over the page range (built on `/api/currency/effect/both`). */
export function Impact({ id, label }: CurrencySectionComponentProps) {
  return (
    <CurrencySection
      id={id}
      title={label}
      explainer="What the exchange rate added to or took from your portfolio in euros."
      state="loading"
    />
  );
}

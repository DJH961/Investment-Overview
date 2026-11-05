import clsx from "clsx";
import { Check, RefreshCw, Tag } from "lucide-react";
import { formatStamp, priceAsOf, sentenceCase, type PriceTime, type StampOptions } from "./stamps";
import "./Freshness.scss";

export interface PriceStampsProps {
  /** When the price is from (see `priceAsOf`). */
  price?: PriceTime;
  /** The price time already in words (e.g. a list's common stamp from `foldStamps`); wins over `price`. */
  priceText?: string | null;
  /** When the app last fetched it (a server instant). */
  updated?: string | null;
  /** "row": one line (tables, holdings lists); "stack": one fact per line. */
  layout?: "row" | "stack";
  /** Drop the words "Price as of" / "Updated" (icons and the tooltip still say which is which). */
  terse?: boolean;
  options?: StampOptions;
  className?: string;
}

/**
 * The two "when" facts side by side, always labelled so they are never
 * confused: a tag icon + "Price as of …" and a refresh icon + "Updated …".
 */
export function PriceStamps({
  price,
  priceText: given,
  updated,
  layout = "row",
  terse = false,
  options,
  className,
}: PriceStampsProps) {
  const priceText = given ?? (price ? priceAsOf(price, options) : null);
  const updatedText = updated ? formatStamp(updated, options) : null;
  // Same moment twice (a live quote fetched just now): say it once.
  const sameMoment = priceText !== null && priceText.replace(/ \((live|close|NAV)\)$/, "") === updatedText;
  if (!priceText && !updatedText) return null;
  const priceTitle = priceText ? `Price as of ${priceText}` : undefined;
  const updatedTitle = updatedText ? `Updated ${updatedText} (when the app last fetched it)` : undefined;
  return (
    <span className={clsx("price-stamps", `price-stamps--${layout}`, className)}>
      {priceText && (
        <span className="price-stamps__item" title={priceTitle}>
          <Tag className="price-stamps__icon" aria-hidden />
          <span className={clsx("price-stamps__key", terse && "price-stamps__key--hidden")}>Price as of</span>{" "}
          <span className="price-stamps__value">{terse ? sentenceCase(priceText) : priceText}</span>
        </span>
      )}
      {updatedText && !sameMoment && (
        <span className="price-stamps__item" title={updatedTitle}>
          <RefreshCw className="price-stamps__icon" aria-hidden />
          <span className={clsx("price-stamps__key", terse && "price-stamps__key--hidden")}>Updated</span>{" "}
          <span className="price-stamps__value">{terse ? sentenceCase(updatedText) : updatedText}</span>
        </span>
      )}
    </span>
  );
}

/**
 * The small ✓ after a holding's price: it already holds the latest settled
 * close (or NAV) while the market is shut. Labelled, never colour alone.
 */
export function PriceTick({ title, className }: { title: string | null; className?: string }) {
  if (!title) return null;
  return (
    <span className={clsx("price-tick", className)} title={title} data-tick={title}>
      <Check className="price-tick__icon" aria-hidden />
      <span className="price-tick__label">{title}</span>
    </span>
  );
}

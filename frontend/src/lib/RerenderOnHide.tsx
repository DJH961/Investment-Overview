import { cloneElement, type ReactElement } from "react";
import { useHideAmounts } from "./hideAmounts";

/**
 * Re-renders the page below it when "Hide numbers" flips, without remounting it.
 * The plain-function formatters in `lib/format.ts` read a module flag, so a page
 * only shows the new masking when it renders again. Subscribing here and cloning the
 * child gives it a fresh props object, which re-renders the whole page tree while
 * keeping every piece of state (drafts, scroll, open sheets, import previews).
 */
export function RerenderOnHide({ children }: { children: ReactElement }) {
  useHideAmounts();
  return cloneElement(children);
}

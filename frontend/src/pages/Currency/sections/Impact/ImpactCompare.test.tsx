import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HideAmountsProvider } from "../../../../lib/hideAmounts";
import type { CurrencyEffectDto } from "../../../../lib/queries/currencyEffect";
import { ImpactCompare, lensesDisagree } from "./ImpactCompare";

type Kind = "tailwind" | "headwind" | "neutral" | "mixed";

const side = (effect: string, kind: Kind, investing?: { effect: string; kind: Kind }) =>
  ({ headline: { effect, kind }, investing: investing ?? null }) as unknown as CurrencyEffectDto;

function mount(eur: CurrencyEffectDto, usd: CurrencyEffectDto) {
  return render(
    <HideAmountsProvider>
      <ImpactCompare eur={eur} usd={usd} />
    </HideAmountsProvider>,
  );
}

describe("ImpactCompare: Mixed only when the lenses genuinely disagree", () => {
  it("lensesDisagree is true only for a helped/cost pair", () => {
    expect(lensesDisagree("tailwind", "headwind")).toBe(true);
    expect(lensesDisagree("headwind", "tailwind")).toBe(true);
    expect(lensesDisagree("tailwind", "tailwind")).toBe(false);
    expect(lensesDisagree("headwind", "neutral")).toBe(false);
    expect(lensesDisagree("mixed", "tailwind")).toBe(false);
  });

  it("euros -89,683 (headwind) against dollars +14,895 (tailwind) says Mixed, with the why", () => {
    mount(side("-89683", "headwind"), side("0", "neutral", { effect: "14895", kind: "tailwind" }));
    expect(screen.getByTestId("lens-mixed")).toHaveTextContent("Mixed");
    expect(screen.getByTestId("lens-mixed")).toHaveTextContent(/cost your euro book and helped the euros you sent in/);
  });

  it("agreeing lenses, or a flat one, show no Mixed line", () => {
    mount(side("500", "tailwind"), side("0", "neutral", { effect: "300", kind: "tailwind" }));
    expect(screen.queryByTestId("lens-mixed")).toBeNull();
  });
});

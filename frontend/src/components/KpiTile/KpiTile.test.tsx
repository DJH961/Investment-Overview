import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Money } from "../Money";
import { KpiTile } from "./KpiTile";

describe("KpiTile", () => {
  it("renders label, long value, delta and hint", () => {
    render(
      <KpiTile
        label="Portfolio value"
        value={<Money amount={-12345678.9} currency="USD" signed />}
        delta={<span>+1%</span>}
        hint="as of today"
      />,
    );
    expect(screen.getByText("Portfolio value")).toBeInTheDocument();
    const value = screen.getByText(/12,345,678\.90/);
    expect(value.closest(".kpi-tile__value")).not.toBeNull();
    expect(screen.getByText("as of today")).toBeInTheDocument();
  });

  it("shows skeletons while loading", () => {
    const { container } = render(<KpiTile label="Today" value="x" loading />);
    expect(screen.queryByText("x")).toBeNull();
    expect(container.querySelector(".kpi-tile__value")).toBeNull();
  });

  it("scales the value down when it is wider than the tile", () => {
    const { container, rerender } = render(<KpiTile label="Big" value="€1,234,567.89" />);
    const el = container.querySelector<HTMLElement>(".kpi-tile__value");
    expect(el).not.toBeNull();
    // jsdom has no layout: fake a 133 px tile and a 200 px figure, then re-render.
    Object.defineProperty(el, "clientWidth", { configurable: true, value: 133 });
    Object.defineProperty(el, "scrollWidth", { configurable: true, value: 200 });
    rerender(<KpiTile label="Big" value="€1,234,567.88" />);
    const fitted = container.querySelector<HTMLElement>(".kpi-tile__value");
    expect(Number(fitted?.style.getPropertyValue("--kpi-tile-fit"))).toBeCloseTo(0.66, 2);
  });
});

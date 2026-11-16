import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HideAmountsProvider } from "../../lib/hideAmounts";
import { setHideAmounts } from "../../lib/format";
import { DaySplit, daySplitMoved, hasSplit, HoldingDaySplit } from "./DaySplit";

afterEach(() => {
  localStorage.clear();
  setHideAmounts(false);
});

describe("daySplitMoved", () => {
  it("needs a visible overnight move: a percent, else money", () => {
    expect(daySplitMoved(-0.0045)).toBe(true);
    expect(daySplitMoved(0)).toBe(false);
    expect(daySplitMoved(0.00001)).toBe(false);
    expect(daySplitMoved(null, -4.5)).toBe(true);
    expect(daySplitMoved(null, 0.001)).toBe(false);
    expect(daySplitMoved(null, null)).toBe(false);
  });
});

describe("DaySplit", () => {
  it("shows ☀ session and ☾ overnight, named for screen readers and on hover, with the explanation", () => {
    const { container } = render(<DaySplit sessionPct={0.0081} overnightPct={-0.0045} currency="EUR" />);
    const el = screen.getByTestId("day-split");
    // The words are visually hidden labels; the symbols say it on screen.
    expect(el).toHaveTextContent(/Session\s*\+0\.81%\s*Overnight\s*-0\.45%/);
    expect(container.querySelectorAll(".day-split__icon")).toHaveLength(2);
    expect(container.querySelector(".day-split__part")).toHaveAttribute("title", expect.stringMatching(/^Session/));
    expect(el).not.toHaveTextContent("next day");
    expect(screen.getByRole("button", { name: "About session and overnight" })).toBeInTheDocument();
  });

  it("never shows in the USD view", () => {
    const { container } = render(<DaySplit sessionPct={0.0081} overnightPct={-0.0045} currency="USD" />);
    expect(container).toBeEmptyDOMElement();
    expect(hasSplit({ day_session_pct: "0.0055", day_overnight_pct: "-0.0045" }, "USD")).toBe(false);
    expect(hasSplit({ day_session_pct: "0.0055", day_overnight_pct: "-0.0045" }, "EUR")).toBe(true);
  });

  it("falls back to the overnight money when there is no percent", () => {
    render(<DaySplit sessionPct={0.01} overnightPct={null} overnight={-4.5} currency="EUR" />);
    expect(screen.getByTestId("day-split")).toHaveTextContent("-€4.50");
  });

  it("draws nothing when the currency did not move, or without a session part", () => {
    const { container, rerender } = render(<DaySplit sessionPct={0.01} overnightPct={0} currency="EUR" />);
    expect(container).toBeEmptyDOMElement();
    rerender(<DaySplit sessionPct={null} overnightPct={-0.01} currency="EUR" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("stacked (a table cell) is one small right-aligned line with both parts, no tip", () => {
    render(<DaySplit sessionPct={0.0055} overnightPct={-0.0045} currency="EUR" layout="stacked" />);
    const el = screen.getByTestId("day-split");
    expect(el).toHaveClass("day-split--compact", "day-split--end");
    expect(el).toHaveTextContent(/\+0\.55%.*-0\.45%/);
    expect(screen.queryByRole("button", { name: "About session and overnight" })).toBeNull();
  });

  it("list (the KPI tile) is the same line, left-aligned", () => {
    render(<DaySplit sessionPct={0.0055} overnightPct={-0.0045} currency="EUR" layout="list" />);
    const el = screen.getByTestId("day-split");
    expect(el).toHaveClass("day-split--compact");
    expect(el).not.toHaveClass("day-split--end");
  });

  it("hide mode shows percents only", () => {
    localStorage.setItem("iv.privacy.hideAmounts", "true");
    render(
      <HideAmountsProvider>
        <DaySplit sessionPct={0.0081} overnightPct={-0.0045} currency="EUR" />
      </HideAmountsProvider>,
    );
    expect(screen.getByTestId("day-split")).toHaveTextContent("-0.45%");
    expect(screen.getByTestId("day-split")).not.toHaveTextContent("€");
  });
});

describe("HoldingDaySplit", () => {
  it("reads a holdings row's server fields", () => {
    render(
      <HoldingDaySplit
        row={{ day_session_pct: "0.0055", day_overnight_pct: "-0.0045", day_overnight: "-5.1" }}
        currency="EUR"
      />,
    );
    expect(screen.getByTestId("day-split")).toHaveTextContent(/Session\s*\+0\.55%\s*Overnight\s*-0\.45%/);
  });

  it("draws nothing for a row without a split (market open, USD view of a USD holding)", () => {
    const { container } = render(
      <HoldingDaySplit
        row={{ day_session_pct: null, day_overnight_pct: null, day_overnight: null }}
        currency="USD"
      />,
    );
    expect(container).toBeEmptyDOMElement();
    const { container: c2 } = render(<HoldingDaySplit row={{}} currency="USD" />);
    expect(c2).toBeEmptyDOMElement();
  });
});

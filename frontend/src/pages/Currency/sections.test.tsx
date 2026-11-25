import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { CurrencySection } from "../../components/CurrencySection";
import { SectionBar } from "../../components/SectionBar";
import { CURRENCY_SECTIONS, findSubPage } from "./sections";

vi.mock("../../lib/shell", () => ({ useShellStatus: () => undefined }));
vi.mock("../../lib/prefs", async (orig) => ({
  ...(await orig<typeof import("../../lib/prefs")>()),
  usePrefs: () => ({ currency: "EUR" }),
}));
vi.mock("../../lib/queries/currency", () => ({
  useCurrency: () => ({ data: undefined, isPending: true, isError: false, isFetching: false, refetch: () => undefined }),
}));

describe("section registry", () => {
  it("lists Impact, Your dollars, Exposure and Scenarios, in that order, with unique ids", () => {
    expect(CURRENCY_SECTIONS.slice(0, 4).map((s) => s.label)).toEqual(["Impact", "Your dollars", "Exposure", "Scenarios"]);
    const ids = CURRENCY_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("sub-page ids are unique and found by URL segment", () => {
    const subs = CURRENCY_SECTIONS.flatMap((s) => s.subPages ?? []).map((p) => p.id);
    expect(new Set(subs).size).toBe(subs.length);
    expect(findSubPage("holdings")?.section.id).toBe("impact");
    expect(findSubPage("nope")).toBeNull();
    expect(findSubPage(undefined)).toBeNull();
  });
});

describe("CurrencySection shell", () => {
  it("is an anchored, labelled section with title and explainer", () => {
    render(
      <CurrencySection id="impact" title="Impact" explainer="What the currency did to you." state="ready">
        <p>content</p>
      </CurrencySection>,
    );
    const section = screen.getByRole("region", { name: "Impact" });
    expect(section.id).toBe("impact");
    expect(screen.getByText("What the currency did to you.")).toBeInTheDocument();
    expect(screen.getByText("content")).toBeInTheDocument();
  });

  it("shows skeleton, error and empty states instead of the content", () => {
    const { rerender, container } = render(
      <CurrencySection id="x" title="X" state="loading">
        <p>content</p>
      </CurrencySection>,
    );
    expect(container.querySelector(".skeleton")).not.toBeNull();
    expect(screen.queryByText("content")).toBeNull();
    rerender(<CurrencySection id="x" title="X" state="error" onRetry={() => undefined} />);
    expect(screen.getByText("X could not be loaded")).toBeInTheDocument();
    rerender(<CurrencySection id="x" title="X" state="empty" emptyTitle="Nothing yet" />);
    expect(screen.getByText("Nothing yet")).toBeInTheDocument();
  });
});

describe("SectionBar", () => {
  it("links each section by anchor", () => {
    render(<SectionBar label="Currency sections" items={CURRENCY_SECTIONS.map(({ id, label }) => ({ id, label }))} />);
    const nav = screen.getByRole("navigation", { name: "Currency sections" });
    expect(nav.querySelectorAll("a")).toHaveLength(CURRENCY_SECTIONS.length);
    expect(screen.getByRole("link", { name: "Impact" })).toHaveAttribute("href", "#impact");
  });
});

describe("/currency/:sub", () => {
  it("an unknown sub-page goes back to the Currency page", async () => {
    const { Currency } = await import("./Currency");
    render(
      <MemoryRouter initialEntries={["/currency/nope"]}>
        <Routes>
          <Route path="/currency/:sub?" element={<Currency />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: "Currency" })).toBeInTheDocument();
  });
});

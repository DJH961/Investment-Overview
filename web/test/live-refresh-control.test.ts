/**
 * Tests for the per-graph "refresh bars" control (`liveRefreshControl`), the
 * Web-UI track O4(b) button spec: it applies only to the live 1D/1W windows
 * (re-pullable price bars) and never to the static history slices. Pure logic,
 * no DOM.
 */
import { describe, expect, it } from "vitest";

import { liveRefreshControl, type RangeOption } from "../src/ui";

const live = (range: "1D" | "1W"): RangeOption => ({ label: range, kind: "live", range });
const history = (label: string, days: number | null): RangeOption => ({ label, kind: "history", days });

describe("liveRefreshControl", () => {
  it("offers a scoped re-pull for the live 1D window (today's session)", () => {
    const control = liveRefreshControl(live("1D"));
    expect(control).not.toBeNull();
    expect(control?.range).toBe("1D");
    expect(control?.ariaLabel).toBe("Refresh 1D bars");
    expect(control?.title).toContain("today's session");
    expect(control?.title).toContain("credits");
  });

  it("offers a scoped re-pull for the live 1W window (the full week)", () => {
    const control = liveRefreshControl(live("1W"));
    expect(control?.range).toBe("1W");
    expect(control?.ariaLabel).toBe("Refresh 1W bars");
    expect(control?.title).toContain("full week");
  });

  it("returns null for every static history slice (nothing to re-fetch)", () => {
    expect(liveRefreshControl(history("1M", 30))).toBeNull();
    expect(liveRefreshControl(history("1Y", 365))).toBeNull();
    expect(liveRefreshControl(history("All", null))).toBeNull();
  });
});

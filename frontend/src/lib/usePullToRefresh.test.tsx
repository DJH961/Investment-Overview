import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PULL_MAX, PULL_THRESHOLD, PullTracker, pullOffset, usePullToRefresh } from "./usePullToRefresh";

describe("pullOffset", () => {
  it("is zero when pushing up and capped when pulling far", () => {
    expect(pullOffset(-20)).toBe(0);
    expect(pullOffset(40)).toBe(20);
    expect(pullOffset(10_000)).toBe(PULL_MAX);
  });
});

describe("PullTracker", () => {
  it("fires after a pull past the threshold from the top", () => {
    const t = new PullTracker();
    t.start(100, true);
    expect(t.move(100 + PULL_THRESHOLD * 2)).toBe(PULL_THRESHOLD);
    expect(t.end()).toBe(true);
  });
  it("does not fire for a short pull", () => {
    const t = new PullTracker();
    t.start(100, true);
    t.move(150);
    expect(t.end()).toBe(false);
  });
  it("does not arm when the page is scrolled down or the touch is inside a scroller", () => {
    const t = new PullTracker();
    t.start(100, false);
    expect(t.move(400)).toBe(0);
    expect(t.end()).toBe(false);
    t.start(100, true, true);
    expect(t.move(400)).toBe(0);
    expect(t.end()).toBe(false);
  });
});

function Probe({ enabled, onRefresh }: { enabled: boolean; onRefresh: () => void }) {
  const { offset } = usePullToRefresh({ enabled, onRefresh });
  return <output data-testid="offset">{offset}</output>;
}

function touch(type: "touchStart" | "touchMove" | "touchEnd", y?: number) {
  const touches = y === undefined ? [] : [{ clientY: y, clientX: 0 }];
  act(() => {
    fireEvent[type](document, { touches });
  });
}

afterEach(() => {
  document.documentElement.style.overscrollBehaviorY = "";
});

describe("usePullToRefresh", () => {
  it("calls onRefresh after a long pull at the top and disables native pull-to-reload", () => {
    const onRefresh = vi.fn();
    const { getByTestId, unmount } = render(<Probe enabled onRefresh={onRefresh} />);
    expect(document.documentElement.style.overscrollBehaviorY).toBe("contain");
    touch("touchStart", 10);
    touch("touchMove", 400);
    expect(getByTestId("offset").textContent).toBe(String(PULL_MAX));
    touch("touchEnd");
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(getByTestId("offset").textContent).toBe("0");
    unmount();
    expect(document.documentElement.style.overscrollBehaviorY).toBe("");
  });

  it("does nothing when disabled", () => {
    const onRefresh = vi.fn();
    render(<Probe enabled={false} onRefresh={onRefresh} />);
    touch("touchStart", 10);
    touch("touchMove", 300);
    touch("touchEnd");
    expect(onRefresh).not.toHaveBeenCalled();
  });
});

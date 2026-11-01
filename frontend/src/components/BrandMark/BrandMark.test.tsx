import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import manifestText from "../../../public/manifest.webmanifest?raw";
import { BrandMark } from "./BrandMark";

// Keys only (lazy glob): which files exist in public/.
const PUBLIC_FILES = new Set(
  Object.keys(import.meta.glob("../../../public/*", { query: "?url" })).map((p) => p.replace("../../../public", "")),
);

describe("BrandMark", () => {
  it("is decorative by default and draws the tile and three bars", () => {
    const { container } = render(<BrandMark size={40} />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("width", "40");
    expect(container.querySelectorAll(".brand-mark__bars rect")).toHaveLength(3);
    expect(container.querySelector("linearGradient")).not.toBeNull();
  });

  it("can be a glyph only, with an accessible name", () => {
    const { container } = render(<BrandMark tile={false} label="Investment Overview" />);
    expect(screen.getByRole("img", { name: "Investment Overview" })).toHaveClass("brand-mark--glyph");
    expect(container.querySelector("linearGradient")).toBeNull();
  });
});

describe("icon set", () => {
  it("the manifest lists any + maskable 192/512 icons and every file exists", () => {
    const manifest = JSON.parse(manifestText) as {
      icons: { src: string; sizes: string; purpose: string }[];
    };
    for (const purpose of ["any", "maskable"]) {
      for (const sizes of ["192x192", "512x512"]) {
        expect(manifest.icons.some((i) => i.purpose === purpose && i.sizes === sizes)).toBe(true);
      }
    }
    for (const icon of manifest.icons) expect(PUBLIC_FILES.has(icon.src)).toBe(true);
    for (const f of ["favicon.ico", "favicon.svg", "apple-touch-icon.png", "icon-monochrome.svg"]) {
      expect(PUBLIC_FILES.has(`/${f}`)).toBe(true);
    }
  });
});

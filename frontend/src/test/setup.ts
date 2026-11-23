import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { setFormatPrefs } from "../lib/format";

// Most tests assert 24-hour stamps; the 12-hour default has its own tests.
beforeEach(() => setFormatPrefs({ hour12: false }));
afterEach(() => cleanup());

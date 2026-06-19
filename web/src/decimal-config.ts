/**
 * Global decimal.js configuration.
 *
 * Imported once by the app entry (`main.ts`) and the test setup so every module
 * shares the same precision. 40 significant digits comfortably exceeds the
 * desktop's Python `decimal` context for the money/ratio magnitudes we handle,
 * keeping the parity suite well inside its 1e-8 tolerance.
 */
import Decimal from "decimal.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

export { Decimal };

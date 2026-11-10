/**
 * Parse a number typed by a person. Accepts a decimal comma or a decimal dot,
 * trims spaces, and understands one group separator ("1.234,56", "1,234.56",
 * "1 234,5"). Returns null for empty or invalid input, never 0 for invalid.
 *
 * A lone separator followed by exactly three digits ("1,234", "1.234") is
 * ambiguous; it is read as a decimal separator (the field is a quantity or
 * price, not a thousands-grouped total) unless the same mark repeats
 * ("1.234.567" is a grouped integer).
 */
export function parseDecimal(input: string): number | null {
  let s = input.replace(/[\s  ']/g, "");
  if (s === "") return null;
  let sign = 1;
  if (s.startsWith("-") || s.startsWith("−")) {
    sign = -1;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  if (s === "" || !/^[\d.,]+$/.test(s)) return null;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let normalised: string;
  if (lastDot >= 0 && lastComma >= 0) {
    // Both marks: the later one is the decimal mark, the other groups.
    const decimalMark = lastDot > lastComma ? "." : ",";
    const groupMark = decimalMark === "." ? "," : ".";
    if (s.split(decimalMark).length > 2) return null;
    const intPart = s.slice(0, s.lastIndexOf(decimalMark));
    const groups = intPart.split(groupMark);
    if (!groups.slice(1).every((p) => p.length === 3)) return null;
    normalised = s.split(groupMark).join("").replace(decimalMark, ".");
  } else if (lastDot >= 0 || lastComma >= 0) {
    const mark = lastDot >= 0 ? "." : ",";
    const parts = s.split(mark);
    if (parts.length > 2) {
      // Repeated mark: must be grouping of an integer.
      if (!parts.slice(1).every((p) => p.length === 3)) return null;
      normalised = parts.join("");
    } else {
      normalised = parts.join(".");
    }
  } else {
    normalised = s;
  }
  if (!/^\d*\.?\d*$/.test(normalised) || normalised === "." ) return null;
  const n = Number(normalised);
  return Number.isFinite(n) ? sign * n : null;
}

/** Canonical dot-decimal string for the API, or null when invalid. */
export function toApiDecimal(input: string): string | null {
  const n = parseDecimal(input);
  if (n === null) return null;
  const s = input.replace(/[\s  ']/g, "");
  // Rebuild from the text so Decimal precision is not lost to float rounding.
  const neg = s.startsWith("-") || s.startsWith("−");
  const body = s.replace(/^[-+−]/, "");
  const lastDot = body.lastIndexOf(".");
  const lastComma = body.lastIndexOf(",");
  const both = lastDot >= 0 && lastComma >= 0;
  let out: string;
  if (both) {
    const mark = lastDot > lastComma ? "." : ",";
    const group = mark === "." ? "," : ".";
    out = body.split(group).join("").replace(mark, ".");
  } else {
    const mark = lastDot >= 0 ? "." : lastComma >= 0 ? "," : "";
    if (mark && body.split(mark).length > 2) out = body.split(mark).join("");
    else out = mark ? body.replace(mark, ".") : body;
  }
  return (neg ? "-" : "") + out;
}

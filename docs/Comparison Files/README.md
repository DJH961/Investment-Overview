# Comparison Files — synthetic / anonymized fixtures

**These files contain NO real financial data.** They are anonymized, fabricated
fixtures kept only so the import/calculation pipeline can be tested and so the
Python ↔ web parity work has reference snapshots to diff against. The original
private exports were removed from this folder **and purged from git history**.

## What was done

| File | Status | How it was faked |
|------|--------|------------------|
| `2023.csv` … `2026.csv` | ✅ anonymized | Fidelity activity exports. All share/amount/cash-balance values scaled by a per-file factor (prices kept realistic). Real public symbols kept; a similar holding added per file (FZROX/FNILX/FTEC). The SCHK share-distribution ("split") event is preserved. Download timestamp genericized. |
| `customActivityReport.xlsx` | ✅ anonymized | Vanguard activity export. Quantities/amounts scaled; the external-bank transfer line was replaced with a generic label; AVUV added as a similar holding. |
| `audit-export-*.json` | ✅ anonymized | Full app snapshots. Every monetary/share/value field scaled by a single factor per file so the snapshots stay **internally consistent** (value = shares × price still holds); scale-invariant fields (XIRR, TWR, %, ratios, risk stats) are unchanged by design. Deposit descriptions naming an external bank were replaced with "External transfer". |
| `Investments.xlsx` | 🚩 **removed, not faked** | The personal master workbook (7 sheets: Total/Deposits/Lots/Growth/Yearly/Vanguard/Fidelity) is driven by hundreds of cross-sheet formulas and derived analytics columns. It cannot be faithfully anonymized by hand without breaking those relationships, so it was **excluded from the public repo**. Keep it locally if you still need it for spreadsheet parity. |

## Important caveats

- Values are deliberately **drastically different** from reality. Do not treat
  any figure here as a real position, balance, or return.
- The JSON snapshots are internally consistent but are **not** the exact output
  of importing these specific CSV/XLSX files — they were anonymized
  independently. If you need an input→output pair that reconciles exactly,
  regenerate a fresh snapshot by importing the synthetic activity files into the
  app and exporting.

# Legacy v5 (frozen at v5.3.1)

## What it is

**v5.3.1 is the final v5 release**: the desktop app (NiceGUI) plus the read-only
web companion. It is frozen on:

- branch `legacy/v5`
- tag `v5.3.1`

It has **zero support**: no fixes, no dependency updates, no backports. It exists
only as a **rollback option** while the v6 rewrite
([`v6_one_app_plan.md`](v6_one_app_plan.md)) settles in. Nothing is ever committed
to `legacy/v5`, except the owner-requested list of known, unfixed v5 bugs
(`docs/legacy_v5_known_bugs.md` on that branch); read it before rolling back.

## Rolling back the desktop app

Pick one:

1. **Installer:** download `InvestmentDashboard-Setup.exe` (or
   `InvestmentDashboard-Portable.zip`) from the GitHub release `v5.3.1` and run it.
2. **From source:** `git checkout legacy/v5`, then start the app with
   `run_dashboard.vbs` (or `run_dashboard.bat`).

Where the data lives (unchanged from v5):

- Ledger and config: `OneDrive\inv-dashboard\`
- Cache (prices, FX, snapshots; safe to rebuild): `%LOCALAPPDATA%\inv-dashboard\cache.sqlite`

## The web companion

The companion only works while all three of these still exist:

- GitHub Pages (workflow `pages.yml`)
- the Cloudflare Worker (`web/proxy/`)
- the `live-data` GitHub release

v6 Phase 4 turns these off. Rolling back the companion therefore means
re-enabling them: re-run `pages.yml` and redeploy the Worker with
`wrangler deploy`.

## Rolling back the data (the important part)

Anything you enter in v6 after cutover is **not** in the old v5 ledger. Going back
to v5 without carrying that data over would lose it. v6 commits to this:

- Every v6 Alembic migration ships a working `downgrade()` back to v5's head
  revision (`0014_v3_9_3_intraday_market_component`). This is tested in CI.
- `tools/export_v5_ledger.py` decrypts a v6 database (SQLCipher) and downgrades it
  into a v5-compatible `ledger.sqlite` and `config.sqlite`. Put those into
  `OneDrive\inv-dashboard\` and start v5.
- The final pre-cutover v5 ledger is also kept as a sealed (encrypted) backup, as
  a last resort.

## Troubleshooting: installed but nothing opens (Windows)

The shortcuts and the portable `.cmd` start the app with the windowless
`pythonw.exe`, which discards all console output, so a crash (port 8080 already in
use, missing dependency, firewall block) looks like "nothing happened". Every
launch therefore writes a `launcher.log` with the environment and any traceback:

- Installed app: `%LOCALAPPDATA%\InvestmentDashboard\launcher.log`
- Portable bundle: next to `Run-InvestmentDashboard.cmd`
- From a source checkout: next to `run_dashboard.py`

Steps, in order:

1. Read `launcher.log` (set `INV_DASHBOARD_LAUNCHER_DEBUG=1` for more detail).
2. Run the launcher with the console interpreter to see errors live, e.g.
   `"%LOCALAPPDATA%\InvestmentDashboard\python\python.exe" "%LOCALAPPDATA%\InvestmentDashboard\launcher.py"`
   (portable: `.\python\python.exe .\portable_launcher.py`).
3. Check the port: `netstat -ano | findstr :8080`. If taken, set
   `INV_DASHBOARD_PORT=8099` and retry.
4. Open `http://localhost:8080` manually; the app may be running with only the
   browser tab missing.

## Security note

Frozen dependencies will age and collect known vulnerabilities. Use legacy v5 only
as a **temporary fallback**, and only on your home network (LAN-only, as before).
Do not expose it to the internet.

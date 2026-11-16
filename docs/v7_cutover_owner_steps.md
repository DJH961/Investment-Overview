# v7.0 cutover: what you do by hand

The release removes the v5 code from the repo. Four things live outside the repo and
only you can switch them off. None is urgent, and none affects the running v6 app or
the GitHub Pages demo. Commands below are for PowerShell.

Why it is safe: nothing in v6 reads the Worker, the `live-data` release or the
publishing keys. The `v5-archive` tag keeps the old code if you ever need to look.

## 1. Delete the Cloudflare Worker

The Worker name is `investment-overview-blob-proxy` (confirm with
`git show v5-archive:web/proxy/wrangler.toml`, line `name = ...`).

1. Open the Cloudflare dashboard and sign in.
2. Left menu: **Workers & Pages**.
3. Click the worker `investment-overview-blob-proxy`.
4. **Settings** tab, scroll to the bottom, **Delete** (confirm by typing the name).
5. Before or after: in the same Settings tab, look at **Domains & Routes** and
   **Variables and Secrets**. The Worker held one secret, `TIINGO_TOKEN`; deleting
   the Worker removes it. Also remove any custom route or domain you attached
   to it (Domains & Routes), and check **Storage & Databases > KV** for a namespace
   you created for it (the Worker config used none, so usually nothing is there).
6. Optional: if the Tiingo token is not used anywhere else (the server has its own
   `INV_DASHBOARD_TIINGO_TOKEN`, a separate copy), you may keep it. Revoke it at
   Tiingo only if you want to stop using Tiingo altogether.

Check it worked: the worker no longer appears under Workers & Pages, and opening its
old `workers.dev` address shows a Cloudflare "not found" page.

## 2. Delete the `live-data` GitHub release and tag

It holds the old encrypted portfolio file (`portfolio.enc`) that v5 published.

Web: GitHub repo, **Releases**, open the release named `live-data`, **Delete**,
confirm. Then **Tags**, find `live-data`, **Delete**.

PowerShell instead (deletes the release and its tag in one go):

```powershell
gh release delete live-data --cleanup-tag --repo DJH961/Investment-Overview
```

Check it worked: `gh release list --repo DJH961/Investment-Overview` no longer shows
`live-data`, and `git ls-remote --tags origin live-data` prints nothing.

## 3. Remove secrets and keys only v5 used

Repo secrets and variables. I compared every workflow on `v5-archive` with the
current ones: they use exactly the same set, so **no repo secret or variable became
unused**. Still in use, keep them: `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`,
`TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`, variables `DEPLOY_ENABLED`, `DEPLOY_MODE`
(`GITHUB_TOKEN` is automatic). If **Settings > Secrets and variables > Actions** shows
any other name (for example a Cloudflare API token or account id you added for
deploying the Worker), it is v5-only: delete it there.

Check it worked: the Actions secrets list holds only the names above.

The publishing token (a fine-grained personal access token):

1. GitHub, your avatar, **Settings > Developer settings > Personal access tokens >
   Fine-grained tokens**.
2. Find the one you made for publishing to this repo (it had write access to
   Contents or Releases on `Investment-Overview`). **Delete** it.

Check it worked: it no longer appears in that list.

Laptop keyring entries (Windows Credential Manager). The v5 desktop app stored the
mobile passphrase and the publish token there. The service is `investment-dashboard`
and the two entries to remove are the user names `mobile-passphrase` and
`publish-token` (source: `git show
v5-archive:backend/src/investment_dashboard/storage/encryption.py`, top of file). To look:

```powershell
cmdkey /list | Select-String -Pattern "investment-dashboard"
```

Delete an entry with `cmdkey /delete:<the target name shown>`, or by clicking:
Start menu, **Credential Manager > Windows Credentials**, find the entries whose
name contains `investment-dashboard` and `mobile-passphrase` or `publish-token`,
**Remove**. Leave `synced-tiers` (the ledger key) and `tiingo-token` alone while you
may still open the old v5 files; the v6 server does not use them.

Check it worked: the `cmdkey /list` command shows no `mobile-passphrase` or
`publish-token` entry.

## 4. GitHub Pages stays on

Do nothing. Pages keeps serving the offline demo (`web/` built with `VITE_DEMO_ONLY=1`
by `pages.yml`). Do not turn Pages off, and do not reconnect it to real data.

Check it worked: the demo page still opens and shows the fake portfolio.

## Last check

Sign in to the v6 site and open Overview: it must look as before. If anything in
this list looks wrong to you, stop and ask; every step above can be redone later.

# Server runbook

How the v6 server is set up and how to look after it, in plain steps. The plan
behind it is [`../docs/v6_one_app_plan.md`](../docs/v6_one_app_plan.md) §3. This
repository is public: no IP addresses or secrets go in here.

## What exists

| Thing | Value |
| --- | --- |
| Server | Hetzner Cloud, x86, 1 vCPU / 1 GB RAM + 2 GB swap, Ubuntu 26.04 LTS, Germany |
| Public IPv4 | see the Hetzner console (keep the primary IP's auto-delete off, so it survives a rebuild) |
| Hetzner firewall | inbound TCP 80 and 443 from anywhere; nothing else |
| Tailnet name | `hetzner-djh-v1` (key expiry disabled; its IP is in the Tailscale admin) |
| Admin user | `daniel`: SSH key only, passwordless sudo, in the `docker` group, plus a console-only password in your password manager |
| Workspace user | `dev`: same SSH key, **no** sudo, **not** in the `docker` group; runs Claude Code, projects in `~/projects` |
| App address | `https://investments.daniel-henke.de` (Porkbun `A` record → public IPv4) |
| Off-site backups | Backblaze B2 bucket `Investment-Overview`, endpoint `s3.eu-central-003.backblazeb2.com`; bucket-scoped key in `~/b2.env` on the server |
| App directory | `/opt/investments` (owned by `daniel`) |

Root login, password login and public SSH are all off. Only ports 80/443 are open to
the internet (Hetzner firewall + `ufw`); everything else goes over Tailscale.

## Everyday access

From PowerShell on the laptop:

```bash
ssh daniel@hetzner-djh-v1
```

This needs Tailscale running on the laptop and your key loaded in the Windows SSH
agent. One-time setup per laptop: in an **admin** PowerShell run
`Get-Service ssh-agent | Set-Service -StartupType Automatic; Start-Service ssh-agent`,
then in a normal PowerShell `ssh-add $env:USERPROFILE\.ssh\id_ed25519` and type the
key's passphrase. The agent remembers it across reboots.

**Locked out?** The Hetzner web console (`>_` on the server page) always works,
independent of SSH, Tailscale and the firewall. Log in there as `daniel` with the
console password from your password manager. That password only works on the
console: SSH password login is off.

## Claude Code on the server

Claude Code runs as the `dev` user, never as `daniel`. `dev` has no sudo and no
Docker access, so a Claude session there cannot touch the app stack, the database,
`~/b2.env` or anything else in `daniel`'s home (which is `750`). It can only work on
the projects in `/home/dev/projects`. `bootstrap.sh` creates the user and installs
Claude Code (Anthropic's native installer, which keeps itself updated).

**One-time login (you do this, it is your account):**

```bash
ssh dev@hetzner-djh-v1
claude
```

Claude prints a link; open it on the laptop, sign in, paste the code back. Then clone
what you want to work on, e.g.
`git clone https://github.com/DJH961/Investment-Overview ~/projects/Investment-Overview`.
To push from the server, run `gh auth login` there (or add a GitHub deploy key for
that repository); keep that login scoped to what you need.

**Three ways in:**

1. **Desktop app (Code tab):** add an SSH connection to `dev@hetzner-djh-v1`, then
   start a session on it and pick a folder under `~/projects`. Needs Tailscale on
   the laptop and the key in the Windows SSH agent (see "Everyday access").
2. **Phone or browser (always on):** `bootstrap.sh` installs a service that keeps
   `claude remote-control` running, also after reboots and crashes, so the server
   always shows up in the Claude app (**Code**) and on claude.ai/code. Switch it on
   once, after the login above:

   ```bash
   ssh dev@hetzner-djh-v1
   systemctl --user enable --now claude-remote
   tmux -L claude-rc attach
   ```

   The last line shows the running Claude. The first time, answer any question it
   asks, check it says remote control is on, then leave with `Ctrl+B`, then `D`
   (never `Ctrl+C`: that stops it, and the service restarts it after 30 seconds).
   - It starts in `~/projects`. To start in one project instead:
     `echo 'CLAUDE_RC_DIR=/home/dev/projects/Investment-Overview' > ~/.config/claude-remote.env`
     then `systemctl --user restart claude-remote`.
   - Status and logs: `systemctl --user status claude-remote`,
     `journalctl --user -u claude-remote -n 50`. Off: `systemctl --user disable --now claude-remote`.
3. **Plain terminal (laptop or phone):** `ssh dev@hetzner-djh-v1`, `tmux new -A -s claude`, `claude`.

**SSH from the phone** (only needed to fix or change things; everyday use is the
Claude app):

1. Install the Tailscale app on the phone, sign in with the same account, switch it on.
2. Install an SSH app (Termius works on iPhone and Android). Generate a key **on the
   phone** (Termius: **Keychain → + → Generate Key → ED25519**, with a passphrase);
   don't copy the laptop key there. Copy its **public** key (one line,
   `ssh-ed25519 …`).
3. From the laptop, add it for `dev` only:
   `ssh dev@hetzner-djh-v1` then
   `echo 'ssh-ed25519 AAAA… phone' >> ~/.ssh/authorized_keys`.
   `bootstrap.sh` keeps such extra keys when it re-runs; after a rebuild from
   scratch, add it again.
4. In the SSH app, add host `hetzner-djh-v1`, user `dev`, with that key.

Lost the phone? Delete its line from `/home/dev/.ssh/authorized_keys` (from the laptop),
and remove the phone in the Tailscale admin.

**Limits:** the server has 1 GB RAM. Claude Code itself is light, but running a
project's full test suite or builds there competes with the live app; prefer CI for
heavy work. Remove access at any time with `sudo deluser --remove-home dev` (as
`daniel`), or skip the user on a rebuild with `DEV_USER= bash bootstrap.sh`.

## Activity logs

The app keeps one log per subject in the data volume, `/data/logs/activity/`:

| File | What is in it |
| --- | --- |
| `auth.log` | logins (password/passkey), **failed logins**, logouts, passkey and password changes |
| `market_data.log` | price, FX and benchmark polling, provider fallbacks, every scheduler job, ETF-twin price jobs (the one-year close backfill per twin that feeds the twin-accuracy figures — including a failed/empty attempt and giving up after repeated failures — the daily retention prune of old twin-price rows, and the manual "Clear stored twin prices" repair job) |
| `imports.log` | broker file uploads, import confirms/discards |
| `changes.log` | manual edits: transactions, accounts, deposits, settings |
| `backups.log` | sealed snapshots, backup downloads, restores |
| `system.log` | startup, shutdown, migrations, watchdog warnings, deploy restart announcements, "memory high" warnings |

Each line has the time (UTC), what happened, the HTTP status, the client IP and the
browser; never passwords, request bodies or cookies. Files rotate at midnight and are
kept **90 days**, then deleted automatically. Everything also stays in the general
`/data/logs/dashboard.log`.

Read one (on the server):

```bash
cd /opt/investments && docker compose exec app tail -n 50 /data/logs/activity/auth.log
```

Failed logins only: `docker compose exec app grep FAILED /data/logs/activity/auth.log`.

## Restart

- **Normal restart:** `ssh daniel@hetzner-djh-v1 'sudo reboot'`, or **Power → Reboot**
  in the Hetzner console. Takes about a minute.
- **Comes back by itself:** firewall, Tailscale, Docker, and every container started
  with a restart policy (`caddy-check` today, the app stack later).
- **Automatic reboots:** security updates reboot the server at 04:30 UTC when a
  kernel update needs it. Nothing to do.
- **Check after a restart:** `ssh daniel@hetzner-djh-v1 'uptime; docker ps; sudo ufw status | head -1'`
  and open `https://investments.daniel-henke.de`.

## Settings changed in the app

Most tuning (price refresh ages, backup retention, import limits, the Tiingo token,
log detail ...) is set in the app under **Settings**. A value set there wins over the
same setting in `app.env`; Settings shows where each value comes from, and
**Settings → System** lists in-app values that hide an `app.env` value. Every change
is kept in the settings history (secrets only as `<redacted>`).

Sign-in limits (idle sign-out, maximum session age, re-sign-in window for sensitive
actions, failed sign-ins per minute) are **ceilings**: the app can only make them
stricter than `app.env` (or its default), never looser. Request body caps stay in
`app.env` only.

If a setting made the app unusable, reset it from the server:

```bash
cd /opt/investments && docker compose exec app inv-dashboard-settings list
docker compose exec app inv-dashboard-settings reset <key>     # or: reset --all
```

The running app picks the change up within a minute; the reset is logged in
`changes.log`.

## Rebuild from scratch (about 30 minutes)

Use this when the server is broken beyond repair or you want a clean start. The
script does the heavy lifting; the steps below are the parts only you can do.

**Before you start**

- Once the v6 app is running: make sure the latest B2 snapshot is recent (see
  "Backups"), then restore with the "server gone" recipe under "Restore". Today the server holds no data, so nothing can be lost.
- Have ready: your password manager, the laptop with this repo, Hetzner, Tailscale,
  Porkbun and Backblaze logins.

**1. Fresh server**

- Easiest: in Hetzner, open the server → **Rebuild** → choose the latest Ubuntu LTS.
  This keeps the same server, IP and firewall, and wipes the disk.
- Or create a new server (Ubuntu LTS, x86, your SSH key, backups on, the existing
  firewall) and attach the existing primary IPv4. If the IP changes anyway, update
  the Porkbun `A` record for `investments` to the new IP.
- Temporarily add **TCP 22 from your home IP** to the Hetzner firewall (look up your
  IP at <https://api.ipify.org>).

**2. Laptop: forget the old server's identity**

The new server has a new SSH identity, so your laptop would warn
"REMOTE HOST IDENTIFICATION HAS CHANGED". Clear the old entries:

```bash
ssh-keygen -R <public-ip>
ssh-keygen -R hetzner-djh-v1
```

Then log in once as root to accept the new identity (`ssh root@<public-ip>`, type
`yes`, then `exit`).

**3. Run the bootstrap (from PowerShell in the repo folder)**

```bash
scp deploy/bootstrap.sh root@<public-ip>:/root/
ssh root@<public-ip> 'bash /root/bootstrap.sh'
ssh daniel@<public-ip> 'echo ok'
ssh daniel@<public-ip> 'sudo LOCK_ROOT=1 bash /root/bootstrap.sh'
```

The third line checks that `daniel` works **before** root login is switched off.

**4. Console password**

```bash
ssh daniel@<public-ip>
sudo passwd daniel
```

Use a new strong password, save it in your password manager, and test it once in the
Hetzner web console.

**5. Tailscale**

- In the Tailscale admin (**Machines**), remove the old `hetzner-djh-v1` first, so the
  new server can take the same name.
- On the server: `sudo tailscale up`, open the printed link, approve.
- In the Tailscale admin: **⋯ → Disable key expiry** for the new machine.

**6. Close public SSH**

```bash
ssh daniel@hetzner-djh-v1 'sudo CLOSE_PUBLIC_SSH=1 bash /root/bootstrap.sh'
```

Then delete the port 22 rule in the Hetzner firewall.

**7. Secrets**

- In Backblaze → **Application Keys**, delete the old `investments-server` key and
  create a new one (bucket `Investment-Overview` only, Read and Write).
- On the server, `nano ~/b2.env` with two lines,
  `AWS_ACCESS_KEY_ID=<keyID>` and `AWS_SECRET_ACCESS_KEY=<applicationKey>`, then
  `chmod 600 ~/b2.env`.
- The app's own secrets go in `/opt/investments/app.env` (template:
  `backend/.env.example`; see "First install" step 2).

**8. Web**

Until the v6 app exists, restore the HTTPS placeholder:

```bash
ssh daniel@hetzner-djh-v1
sudo install -d -o daniel -g daniel /opt/investments
printf 'investments.daniel-henke.de {\n\theader X-Robots-Tag "noindex, nofollow"\n\trespond "ok - Investment Overview placeholder" 200\n}\n' > /opt/investments/Caddyfile
docker run -d --name caddy-check --restart unless-stopped -p 80:80 -p 443:443 \
  -v /opt/investments/Caddyfile:/etc/caddy/Caddyfile:ro -v caddy_data:/data -v caddy_config:/config caddy:2
```

Once v6 Phase 2 exists, this step becomes "deploy the app stack and restore the data
from B2".

**9. Check**

`https://investments.daniel-henke.de` loads, `ssh daniel@hetzner-djh-v1` works, and
`ssh root@<public-ip>` is refused.

`bootstrap.sh` can be re-run (each step checks before it changes anything), but
**only with `CLOSE_PUBLIC_SSH=1`**: a re-run without it runs `ufw allow 22/tcp` and
reopens public SSH. The re-run command on the finished server is:

```bash
ssh daniel@hetzner-djh-v1 'sudo CLOSE_PUBLIC_SSH=1 bash /root/bootstrap.sh'
```

(Windows Git Bash: use `/c/Windows/System32/OpenSSH/ssh.exe`.) To put a new
`bootstrap.sh` on the server first, copy it to `/tmp` and install it as root:

```bash
scp deploy/bootstrap.sh daniel@hetzner-djh-v1:/tmp/bootstrap.sh
ssh daniel@hetzner-djh-v1 'sudo install -o root -g root -m 700 /tmp/bootstrap.sh /root/bootstrap.sh'
```

(Windows: `scp.exe` from the same OpenSSH folder.)

## Updates

- **OS:** `unattended-upgrades` installs security updates daily and reboots at
  04:30 UTC when a kernel update needs it.
- **Manual catch-up** (rarely needed): `sudo apt-get update && sudo apt-get full-upgrade`,
  then `sudo reboot` if `/var/run/reboot-required` exists.
- **Containers:** the app image is updated by the deploy workflow (v6 Phase 2).

## Deploying v6

After the one-time setup in "Secrets" below, every green commit on `main` deploys by
itself: GitHub builds the image, pushes it to GHCR (GitHub's container registry), joins
your Tailscale network, and runs on the server (in `/opt/investments`)
`docker compose pull app && docker compose up -d app`. It then asks the app's
`/api/health` for up to two minutes. If the app does not answer, the workflow puts the
previous version back and the run turns red.

- **Check `app.env` before deploying:** the server refuses to boot on an unsafe
  configuration (non-https origin, RP ID that does not match the origin, insecure
  cookies, passphrases shorter than 20 characters or placeholders). Preview it on the
  server (read-only; prints PASS/FAIL per rule, never the secret values):
  `cd /opt/investments && docker compose run --rm --no-deps app inv-dashboard-check-config`
  (it exits 1 on any FAIL). Fix `app.env` first, then deploy. `deploy/check.sh` runs
  from your laptop against the public site, so it cannot read `app.env`.
- **Switch it on or off:** GitHub repo, **Settings -> Secrets and variables -> Actions
  -> Variables**, `DEPLOY_ENABLED` = `true` (anything else, or missing, = nothing
  deploys).
- **Deploy by hand:** repo **Actions** tab -> **Deploy** -> **Run workflow**.
- **Who can trigger it:** only a CI run that was a *push* to `main` of this repository
  (pull requests, forks and other branches never deploy), or a manual run started on
  `main`. The job runs in the GitHub environment `production`, which holds the deploy
  secrets.
- **What runs where:** the version in use is the line `APP_TAG=<git sha>` in
  `/opt/investments/.env` on the server; the compose file reads it. The deploy key can
  only run `/opt/investments/deploy.sh` (a forced command, see Secrets B). The workflow
  sends it the commit's `docker-compose.yml`, `Caddyfile`, `restore.sh` and
  `first_install.sh` as a tar stream plus the 40-character git sha; the script installs
  exactly those four names, pulls and starts the new app image and rolls back when the
  health check fails. The server never needs a git checkout. Secrets (`app.env`,
  `rclone.conf`, `.env`) are never touched. `deploy.sh` itself is **not** replaced by a
  deploy: when it changes in the repo, install it again by hand (Secrets B).
- **Disk space:** after a healthy deploy the script deletes the server's local copies
  of older app images and keeps only the running one and the previous one (the
  rollback target). Older versions stay in GHCR and are pulled again when needed.
- **Changed compose file or Caddyfile:** a deploy runs `docker compose up -d`, which
  recreates any service whose compose settings changed, and reloads Caddy's config.
  A changed network definition cannot be applied to running containers; if a deploy
  fails on that, run `docker compose down && docker compose up -d` on the server once
  (the data volumes are kept).
- **Restart announcement:** after pulling the new image and before restarting, `deploy.sh`
  runs a tiny Python call inside the running app container. It reads the per-boot token
  from `/tmp/inv-restart.token` and POSTs `restarting` to `127.0.0.1:8000/api/ops/announce-restart`.
  That route answers only to loopback with the token (anything else gets 404) and puts
  a `server` event on the live stream, so open browsers show "Updating, back in about
  20 s" and keep their data. Then it waits 2 s. If the announcement fails (older image
  without the route, app down) the deploy goes on. The app container gets 5 s to stop
  (`stop_grace_period`). The line "restart announced" lands in `system.log`.
- **Deploy timing (`DEPLOY_MODE`):** repo variable under the same Variables page.
  `immediate` (or missing) deploys every green push to `main`. `scheduled` deploys only
  at 21:30 UTC on weekdays and every 4 hours on weekends (the latest `main` commit, if
  its CI is green and it is not already the last deployed one), or at once when the
  commit message of the push has the line `Deploy: now`. **Run workflow** always
  deploys immediately.
- **Reinstall `deploy.sh` (when it changed in the repo):** copy it to the server and
  install it as root: `scp deploy/deploy.sh daniel@hetzner-djh-v1:/tmp/` then
  `ssh daniel@hetzner-djh-v1 'sudo install -o root -g root -m 755 /tmp/deploy.sh /opt/investments/deploy.sh'`
  (on the Windows laptop use `/c/Windows/System32/OpenSSH/ssh.exe` and `scp.exe`). The
  announce step only starts working after this reinstall.
- **Look at it:** `ssh daniel@hetzner-djh-v1 'cd /opt/investments && docker compose ps && docker compose logs --tail 50 app'`

### Memory

The server has 1 GB RAM and the app container is capped at 512 MB. `bootstrap.sh`
sets up **zram** (compressed swap in RAM, about 25% of memory, priority above the
2 GB swap file, via `systemd-zram-generator`), so the swap file is only touched
when zram is full. Check with `swapon --show` (two lines: `/dev/zram0` first) and
`zramctl`. The image sets `MALLOC_ARENA_MAX=2` to keep glibc from reserving a
memory arena per thread. The Data Health page shows the app's resident memory and
swap; above 400 MB the app writes a "memory high" warning (at most once an hour) to
`system.log`.

zram is enabled by (re-)running `bootstrap.sh` once on the existing server. Always
run it as `sudo CLOSE_PUBLIC_SSH=1 bash /root/bootstrap.sh`; without
`CLOSE_PUBLIC_SSH=1` it reopens public SSH (see "Rebuild from scratch" for copying a
new `bootstrap.sh` to `/root` first):
`ssh daniel@hetzner-djh-v1 'sudo CLOSE_PUBLIC_SSH=1 bash /root/bootstrap.sh'`
(Windows: `/c/Windows/System32/OpenSSH/ssh.exe`).

## Rolling back

Automatic: a failed health check restores the previous tag (see above).

By hand, to any older version (every deployed commit stays in GHCR as
`ghcr.io/djh961/investment-overview:<git sha>`; find the sha in the repo's commit list):

```bash
ssh daniel@hetzner-djh-v1
cd /opt/investments
sed -i 's/^APP_TAG=.*/APP_TAG=<old git sha>/' .env
docker compose pull app && docker compose up -d app
```

Then turn `DEPLOY_ENABLED` off (or the next green commit deploys over it) until the
bad commit is fixed. A rollback never touches the data in the `app-data` volume; if a
migration changed the database shape, restore the data instead (see
"Restore" below).

## Secrets

Everything below is created by you (AGENTS.md: agents never handle secrets). Never
paste any of it into chat, an issue or a file in the repo.

**A. Tailscale OAuth client (lets GitHub reach the server)**

1. Tailscale admin console -> **Access controls**: add `"tag:ci": ["autogroup:admin"]`
   under `tagOwners`, and an `acls` rule allowing `tag:ci` to reach the server on
   port 22. Save.
2. **Settings -> OAuth clients -> Generate OAuth client**, scope **Auth Keys: write**,
   tag `tag:ci`. Copy the client ID and secret.
3. GitHub repo -> **Settings -> Secrets and variables -> Actions -> Secrets -> New
   repository secret**: `TS_OAUTH_CLIENT_ID` and `TS_OAUTH_SECRET`.

**B. Deploy SSH key (GitHub logs in to the server with it)**

1. On the laptop, PowerShell: `ssh-keygen -t ed25519 -f $env:USERPROFILE\.ssh\inv_deploy -N '""'`
   (a key without passphrase, used only for this).
2. Install the forced-command script on the server (owner types this on the server,
   after copying `deploy/deploy.sh` there):
   `sudo install -o root -g root -m 755 deploy.sh /opt/investments/deploy.sh`.
   It is owned by root so the deploy key cannot rewrite it.
3. Add the public half on the server, **restricted to that script**:
   `ssh daniel@hetzner-djh-v1` then add one line to `~/.ssh/authorized_keys`:

   ```
   restrict,command="/opt/investments/deploy.sh" ssh-ed25519 AAAA... inv-deploy
   ```

   (the key type and base64 from `inv_deploy.pub`; the last word is only a label, and
   the key installed today is labelled `github-deploy`). With this line the key cannot
   open a shell, forward ports or copy files; it can only run `deploy <git sha>`.
4. GitHub environment **production** (repo **Settings -> Environments**): limit it to
   the `main` branch and put the secrets of A and B in it. `DEPLOY_SSH_KEY` = the full
   contents of the private file `inv_deploy` (including the `BEGIN`/`END` lines). Then
   delete the private file from the laptop.
5. Pin the server's host key: from a trusted machine on the tailnet run
   `ssh-keyscan -t ed25519 hetzner-djh-v1` and store its output line as the secret
   `DEPLOY_KNOWN_HOSTS`. The workflow refuses to connect to any other host key.
   The Windows `ssh-keyscan.exe` is too old for the server ("unsupported KEX method");
   instead take the laptop's already-trusted entry, `ssh-keygen -F hetzner-djh-v1`,
   and store its `hetzner-djh-v1 ssh-ed25519 AAAA...` line.

**C. Let the server pull the image from GHCR (owner types this on the server)**

1. GitHub -> your avatar -> **Settings -> Developer settings -> Personal access tokens
   -> Tokens (classic) -> Generate new token**, scope `read:packages` only.
2. On the server: `docker login ghcr.io -u DJH961` and paste the token at the password
   prompt (it is stored in `~/.docker/config.json` on the server).

**D. App secrets (owner types these on the server)**

Create `/opt/investments/app.env` (mode 600) from `backend/.env.example` with the
database passphrase, the backup passphrase and the public address (passkeys). Generate
each random value with `openssl rand -base64 32`. Keep both passphrases in your
password manager as well: losing the DB passphrase means losing the data.

**E. Switch deploys on:** variable `DEPLOY_ENABLED` = `true` (see "Deploying v6"), but
only after "First install" has worked once by hand.

| GitHub item | Kind |
| --- | --- |
| `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS` | secrets of the `production` environment |
| `DEPLOY_ENABLED` | variable |

## First install

Do this once, after the server is rebuilt/bootstrapped (see "Rebuild from scratch") and
before switching `DEPLOY_ENABLED` on. Everything lives in `/opt/investments`; secrets
A-E are in the "Secrets" section further down.

1. **Secrets A-C** (Tailscale OAuth client, deploy SSH key, GHCR login on the server).
2. **Secret D, on the server:** create `/opt/investments/app.env` from
   `backend/.env.example` (`nano /opt/investments/app.env`, then
   `chmod 600 /opt/investments/app.env`). Fill in at least the database passphrase,
   the backup passphrase, `INV_DASHBOARD_WEBAUTHN_RP_ID` and
   `INV_DASHBOARD_WEBAUTHN_ORIGIN`. Leave the optional token lines commented out.
   Both passphrases need at least 20 characters. `INV_DASHBOARD_FORWARDED_ALLOW_IPS`
   needs no entry: `docker-compose.yml` gives the internal network the fixed subnet
   `172.29.84.0/24`, pins Caddy to `172.29.84.2` and tells the app to trust
   `X-Forwarded-For` from that address only (Caddy sets it by default), so the
   per-IP login limits see real client addresses. If that subnet clashes with
   something on the server, change it and the address in both places.
3. **Backups, on the server:** copy `rclone.conf.example` to
   `/opt/investments/rclone.conf`, fill in the B2 key, `chmod 600` it and
   `sudo chown 10001:10001` it (the backup container runs as uid 10001; see "Backups").
4. **Get the deploy files onto the server** (no git checkout there). From Git Bash in
   the repo folder:

   ```bash
   /c/Windows/System32/OpenSSH/scp.exe deploy/docker-compose.yml deploy/Caddyfile deploy/restore.sh deploy/first_install.sh daniel@hetzner-djh-v1:/opt/investments/
   ```

   (After secret E the deploy workflow does this by itself on every deploy.) Also copy
   `deploy/deploy.sh` and install it as described in Secrets B. Create the backups
   folder once, because the `backup` sidecar mounts only that sub-folder of the data
   volume: `docker compose run --rm --no-deps --entrypoint mkdir app -p /data/backups`.
5. **Run the installer, on the server:**

   ```bash
   cd /opt/investments && chmod +x first_install.sh restore.sh && ./first_install.sh
   ```

   It checks Docker, the GHCR login, `app.env` (mode 600 and the required keys, never
   printing values) and `rclone.conf`, removes the `caddy-check` placeholder, runs
   `docker compose up -d` and waits for `/api/health`. If a check fails it says exactly
   what is missing; fix that and run it again.
6. **Set your password, on the server** (you type it; it is not written to any file):

   ```bash
   cd /opt/investments && docker compose exec app inv-dashboard-set-password
   ```

7. **Upload your ledger:** follow "Uploading the ledger" below.
8. **Check from the laptop** (Git Bash, repo folder): `bash deploy/check.sh` (health,
   401 without a login, security headers, HSTS, valid TLS, and with `nmap` installed
   only ports 80/443 open). Sign in at `https://investments.daniel-henke.de`, add a
   passkey on the Onboarding page, and compare the totals with v5.
9. **Switch automatic deploys on** (secret E).

## Try it before the server

Run the real v6 app on your laptop with a copy of your real ledger, and open it on your
phone, before the server is involved. Your v5 files are only read.

1. Close the v5 app. Tailscale must be running on the laptop and on the phone.
2. **Easy way:** in Windows PowerShell, from the repo folder, run
   `.\deploy\try_local.ps1`. It asks for the folder with `ledger.sqlite` and
   `config.sqlite` and does everything below. **By hand:** follow steps 3 to 7.
3. Copy the two files into an empty working folder, e.g. `C:\Temp\upload`.
4. Make one database from the copies. On the laptop it stays unencrypted (`--plain`),
   like the v5 files it comes from, because Windows has no SQLCipher driver; the
   server copy is always encrypted.

   ```bash
   cd backend
   uv run inv-dashboard-upload-db --ledger C:/Temp/upload/ledger.sqlite --config C:/Temp/upload/config.sqlite --cache $env:LOCALAPPDATA/inv-dashboard/cache.sqlite --out C:/Temp/upload/app.sqlite --local-only --plain
   ```

5. Build the frontend once: `cd frontend && npm install && npm run build`.
6. Find your laptop's Tailscale name (`tailscale status --json`, field `Self.DNSName`,
   without the trailing dot), e.g. `my-laptop.my-tailnet.ts.net`. Passkeys need HTTPS
   and an address that matches exactly, so in the same PowerShell window (from
   `backend/`):

   ```powershell
   $env:INV_DASHBOARD_DB_PATH = "C:\Temp\upload\app.sqlite"
   $env:INV_DASHBOARD_SERVER_MODE = "true"
   $env:INV_DASHBOARD_ENCRYPT_SYNCED_TIERS = "false"
   $env:INV_DASHBOARD_COOKIE_SECURE = "true"
   $env:INV_DASHBOARD_HOST = "127.0.0.1"
   $env:INV_DASHBOARD_PORT = "8000"
   $env:INV_DASHBOARD_FRONTEND_DIST = "..\frontend\dist"
   $env:INV_DASHBOARD_WEBAUTHN_RP_ID = "my-laptop.my-tailnet.ts.net"
   $env:INV_DASHBOARD_WEBAUTHN_ORIGIN = "https://my-laptop.my-tailnet.ts.net"
   uv run inv-dashboard-set-password
   ```

7. Share it over Tailscale and start the server:

   ```powershell
   tailscale serve --bg 8000
   uv run inv-dashboard-server
   ```

   On the laptop or phone open `https://my-laptop.my-tailnet.ts.net`, sign in, add a
   passkey. Press Ctrl+C to stop, then `tailscale serve reset` to stop sharing.
8. Clean up: delete `C:\Temp\upload` (it holds your ledger) and close the PowerShell
   window.

## Rollback to v5

Use this only if v6 has to be abandoned. It turns the server's database back into the
two files the v5.3.1 desktop app reads. Anything that exists only in v6 (FX conversion
batches, passkeys, the login password) is not carried over.

1. On the server: `cd /opt/investments && docker compose stop app`, then make a spare
   copy of the database first (see "Backups").
2. Export (asks for the DB passphrase; never changes `app.sqlite`):
   `docker compose run --rm --no-deps -v /tmp/v5-export:/out --entrypoint inv-dashboard-export-v5 app --db /data/app.sqlite --out /out`
3. From Git Bash on the laptop:
   `/c/Windows/System32/OpenSSH/scp.exe -r daniel@hetzner-djh-v1:/tmp/v5-export .`
   then on the server `rm -r /tmp/v5-export`.
4. Close the v5 desktop app. In `OneDrive\inv-dashboard\`, rename the current
   `ledger.sqlite` and `config.sqlite` to `*.bak`.
5. Copy `ledger.sqlite` and `config.sqlite` from the export into that folder.
6. Start v5 (installer or `git checkout legacy/v5`, see `docs/legacy_v5.md`). It
   rebuilds prices and FX itself on the first refresh. Read
   `docs/legacy_v5_known_bugs.md` on that branch for the numbers v5 gets wrong.
7. Leave the server stopped, or `docker compose up -d app` to go back to v6.

## Side-by-side week

After the first upload, run v5 (desktop, as always) and v6 (server) together for a week.
v5 stays the source of truth until you switch.

- **Every day:** open both, look at Overview and Holdings in EUR and in USD. Compare the
  totals (value, invested, gain), XIRR/TWR and the biggest holding. Write the numbers and
  the date in your own notes (not in this repo).
- **If something differs:** first check Diagnostics in v6 (deposits at the ECB rate,
  missing prices). Known v5 bugs are listed in `docs/legacy_v5.md`; a difference you can
  explain from there is expected. Anything else: stop and ask before trusting v6.
- **New data during the week:** enter it in v5 only, then repeat "Uploading the ledger"
  (it replaces the server database) when you want v6 to catch up. Do not enter data in
  both.
- **When to switch:** seven days in a row with no unexplained difference, backups
  visible in B2 every day (see "Backups"), and one successful restore drill (see
  "Restore"). Then: do a final upload from v5, stop using v5, and from then on enter
  data in v6 only. Keep the v5 files and the "Rollback to v5" steps for at least a month.

## Uploading the ledger

One-off (or repeated for a rehearsal): turns your v5 `ledger.sqlite` and
`config.sqlite` into a single encrypted file for the server. Your v5 files are only
read; the tool works on copies.

1. **Close the v5 app**, then copy `ledger.sqlite` and `config.sqlite` from your
   OneDrive folder into an empty folder, e.g. `C:\Temp\upload`. (Copies, so the app
   cannot write to them while you work.)
2. **Run the tool** (owner types the passphrase; it is the same value as the app's
   `INV_DASHBOARD_DB_PASSPHRASE`; it is asked for with hidden input):

   ```bash
   cd backend
   uv run inv-dashboard-upload-db --ledger C:/Temp/upload/ledger.sqlite --config C:/Temp/upload/config.sqlite --out C:/Temp/upload/app.sqlite
   ```

   It checks the files, brings them to the current schema, merges config into the
   ledger, removes instruments and accounts with no transactions (it lists them;
   `--no-prune` keeps everything), encrypts, reopens the result with the key and
   compares the row counts. It prints the counts and the commands below.
   If it says there is no SQLCipher driver (typical on Windows), run it inside the
   container instead: copy the two files to the server first, then
   `docker compose run --rm -v ~/upload:/in app inv-dashboard-upload-db --ledger /in/ledger.sqlite --config /in/config.sqlite --out /in/app.sqlite`
   (owner types the passphrase there).
3. **Copy to the server** from Git Bash:
   `/c/Windows/System32/OpenSSH/scp.exe C:/Temp/upload/app.sqlite daniel@hetzner-djh-v1:/tmp/app.sqlite`
4. **Put it in the data volume** (this replaces the server's database; the app is
   stopped meanwhile). On the server:

   ```bash
   cd /opt/investments
   docker compose stop app
   docker compose run --rm --no-deps -v /tmp/app.sqlite:/in/app.sqlite:ro --entrypoint sh app -c 'cp /in/app.sqlite /data/app.sqlite && rm -f /data/app.sqlite-wal /data/app.sqlite-shm'
   rm /tmp/app.sqlite
   docker compose up -d app
   ```
5. **Check:** open `https://investments.daniel-henke.de` and compare the totals with
   the v5 app. Then delete `C:\Temp\upload` (it holds your ledger).

## Backups

What is backed up: the whole database (`/data/app.sqlite`, including passkeys and
settings; it is SQLCipher-encrypted already). Prices and FX are re-downloadable and
are just part of the same file.

- **Sealed snapshots.** The app takes a consistent copy of the running database about a
  minute after any change, and at least once a night, and seals it (AES-256-GCM) into
  `/data/backups/snapshot-YYYYMMDD-HHMMSS.sealed.json`. Kept: the newest of each of the
  last 24 hours, 14 days and 12 months.
- **Off-site.** The `backup` container copies `/data/backups` to the B2 bucket
  (`b2:Investment-Overview/snapshots`) every 5 minutes. It only adds files (never
  deletes or overwrites), so a compromised server cannot erase history. In Backblaze set
  the bucket lifecycle to **Keep all versions** (and delete old ones only if you want to
  save space).
- **Download from the app:** Settings -> Download backup (the same sealed file,
  `GET /api/backup?kind=sealed`).

**One-time setup (you do this on the server)**

1. Copy `deploy/rclone.conf.example` to
   `/opt/investments/rclone.conf`, fill in the B2 *application key ID* and *key* (bucket
   `Investment-Overview` only), then `chmod 600 /opt/investments/rclone.conf` and
   `sudo chown 10001:10001 /opt/investments/rclone.conf` (the backup container runs as
   uid 10001 and cannot read a file only `daniel` owns).
2. In `app.env` add `INV_DASHBOARD_BACKUP_PASSPHRASE=<long random value>` (for example
   `openssl rand -base64 32`). If you leave it out, the database passphrase is used.
3. **Store offline (password manager, plus a printout if you like):** the database
   passphrase `INV_DASHBOARD_DB_PASSPHRASE`, the backup passphrase, and the B2
   application key. A restore needs both passphrases; without them the backups are
   unreadable by design.
4. `docker compose up -d` and check after a few minutes:
   `docker compose logs backup | tail` shows no errors, and the file appears in the
   bucket.

## Restore

The command is `inv-dashboard-restore`. It lists snapshots, unseals the one you pick,
checks the SQLite integrity and the row counts recorded when it was sealed, and only
then swaps it in atomically. The database it replaces is kept next to it as
`app.sqlite.before-restore-<time>` (nothing is deleted). If anything fails it says so
and leaves the live database untouched.

One command does everything: `deploy/restore.sh` (in `/opt/investments` next to
`docker-compose.yml`). It fetches the snapshots from B2 through the compose `backup`
(rclone) service, stops the app, runs `inv-dashboard-restore`, and starts the app again
(also when the restore fails, then with the old database). `./restore.sh --list` only
shows the snapshots; `--yes` skips the confirmation.

**Server gone (new server, empty volume)**

1. Rebuild the server (see "Rebuild from scratch"), put `app.env` (with both
   passphrases) and `rclone.conf` into `/opt/investments`, and start the stack once:
   `docker compose up -d`.
2. Restore the newest snapshot:

   ```bash
   cd /opt/investments
   ./restore.sh
   ```

3. Open the site and compare the totals with a recent screenshot or the v5 app.

**Bad import or a mistake you want to undo (server is fine)**

```bash
cd /opt/investments
./restore.sh --list                                           # pick a time before the mistake
./restore.sh --at snapshot-20261101-120000.sealed.json
```

Anything entered after that snapshot is lost; the state just before the restore is
still in `app.sqlite.before-restore-<time>` if you need to look at it.

**After any restore:** `inv-dashboard-restore` signs every login session out (the
snapshot would otherwise bring back the sessions of its day), but the password hash and
passkeys come back as they were when the snapshot was taken. If you changed the
password or removed a passkey since, or you restore because of a suspected break-in,
run `docker compose exec app inv-dashboard-set-password` right away (it also signs
everything out) and re-check the passkeys on the Settings page.

**If the restore refuses:** "wrong passphrase / tampered" means the backup passphrase
differs from the one the snapshot was sealed with; "database cannot be read" means the
database passphrase is wrong; "row counts differ" or "integrity" means that file is
damaged: try the previous snapshot.

**Drill checklist (do this once before relying on it, then every few months)**

- [ ] `docker compose logs backup | tail` clean; newest object in B2 is minutes old.
- [ ] On a scratch machine or a second compose project: fresh volume, `app.env` and
      `rclone.conf` only from your password manager.
- [ ] `./restore.sh --list`, then `./restore.sh` (newest).
- [ ] App starts, login works (passkey or password), totals match the live site.
- [ ] Try `./restore.sh --at <older file>`, and confirm a wrong passphrase is refused.
- [ ] Note the date of the drill here or in your own log.

**Quick drill on the live server (live database untouched):** fetch from B2 into a
scratch folder, restore there, compare, delete it.

```bash
cd /opt/investments
docker compose run --rm --no-deps --entrypoint rclone backup copy b2:Investment-Overview/snapshots /data/backups/drill --include "snapshot-*.sealed.json" --cache-dir /tmp/rclone
docker compose exec app inv-dashboard-restore --dir /data/backups/drill --latest --db /data/drill/app.sqlite --yes
docker compose exec app rm -rf /data/drill /data/backups/drill
```

**Drill log**

- 2026-11-01: quick drill. Newest sealed snapshot fetched from B2, restored into a
  scratch file: still SQLCipher-encrypted, row counts of all 18 tables equal to the
  live database, a wrong backup passphrase refused ("decryption failed"). Not yet
  done: the full "server gone" drill with passphrases taken only from the password
  manager.

## Firewall note

Docker-published ports bypass `ufw`. Only the Caddy container publishes ports
(80/443, which are public anyway); app containers must never publish ports.

## Current state (Phase 0 checks)

- `caddy-check` container (Caddy 2.11) serves a placeholder `ok` page with a valid
  Let's Encrypt certificate, `X-Robots-Tag: noindex`, and redirects HTTP → HTTPS.
  It is replaced by the real stack in v6 Phase 2: `docker rm -f caddy-check`.
- yfinance one-shot from the server (2026-10-31): daily closes and 1-minute bars
  returned in under 2 s.
- All-day yfinance polling test (2026-11-02, one US session, a call every minute):
  no failures or throttling, a median of 2.1 s per call and a slowest of 15 s. The
  throwaway job was removed from the server on 2026-11-03.
- B2 (2026-10-31): a bucket-scoped key in `~/b2.env` (mode 600) can upload, list,
  download and delete in `Investment-Overview`, and is refused when listing other buckets.
  Replace it, see "Security checklist" item 5.

## Security checklist (owner)

Steps only you can do (they need your accounts or root on the server). Tick them off and
re-run `bash deploy/check.sh` from the laptop afterwards. Background: `SECURITY.md`.

**Now, before anything else**

- [ ] GitHub variable `DEPLOY_ENABLED` = `false` until the hardened deploy workflow is
      merged and the items under "GitHub" below are done; then set it to `true` again.
- [ ] Repo **Settings -> Actions -> General**: *Fork pull request workflows* ->
      **Require approval for all outside collaborators**.

**GitHub**

- [ ] Ruleset on `main`: pull request required, required status checks (CI), no force
      push, no deletion. Tag protection for `v*`.
- [ ] Environment `production` limited to the `main` branch, holding the deploy secrets
      (Secrets A and B). Secret `DEPLOY_KNOWN_HOSTS` set (Secrets B, step 5).
- [ ] Dependabot alerts and security updates on (`.github/dependabot.yml` already asks
      for weekly action, Python, npm and Docker updates; merge them only when CI is green).
- [ ] Secret scanning with push protection on; private vulnerability reporting on.

**Server**

- [ ] `deploy.sh` installed as root (Secrets B, step 2) and the deploy key restricted to it
      (step 3). Test with a manual run of the **Deploy** workflow.
- [ ] `docker compose up -d` run once after the hardened `docker-compose.yml` arrived:
      Caddy now drops all capabilities except binding 80/443 and has a read-only root
      filesystem; the backup sidecar sees only the `backups` folder. Needs Docker
      Compose >= 2.23 for the sidecar (`docker compose version`). If Caddy fails to
      start, `docker compose logs caddy` says why; put the old file back to restore the
      site while you look.
- [ ] A login password really is set (`docker compose exec app inv-dashboard-set-password`;
      works on the encrypted database).
- [ ] Optional: mount `/proc` with `hidepid=2` so other accounts on the host cannot see
      process command lines. The 1 GB host also runs development work; consider 2 GB.

**Backups (B2)**

- [ ] Replace the application key in `rclone.conf` by one **without** delete rights
      (`deleteFiles` off) for the bucket, turn on **Object Lock** with a default retention
      on the bucket, and keep a separate read-only key for restores offline (password
      manager). Decide whether `~/b2.env` (the old delete-capable key) is still needed;
      if not, delete the key in Backblaze and the file.

**Images**

- [ ] Base images in `Dockerfile` and `docker-compose.yml` are pinned by digest
      (resolved from the registries on 2026-11-01 for the tags `node:22-slim`,
      `python:3.12-slim`, `uv:0.5`, `caddy:2.11`, `rclone:1.68`). Dependabot proposes
      digest updates. The `caddy` and `rclone` digests may be newer than the image
      currently running: the first `docker compose up -d` pulls them.

**Rotating secrets (not automated yet)**

- The SQLCipher key and the backup passphrase have no rotation tool. Until one exists a
  rotation means: restore a snapshot into a new database with the new keys by hand. Do
  not change `INV_DASHBOARD_DB_PASSPHRASE` or `INV_DASHBOARD_BACKUP_PASSPHRASE` in
  `app.env` without that, or the app cannot open its data and old snapshots cannot be
  unsealed.

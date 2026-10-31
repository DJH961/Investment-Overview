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

## Restart

- **Normal restart:** `ssh daniel@hetzner-djh-v1 'sudo reboot'`, or **Power → Reboot**
  in the Hetzner console. Takes about a minute.
- **Comes back by itself:** firewall, Tailscale, Docker, and every container started
  with a restart policy (`caddy-check` today, the app stack later).
- **Automatic reboots:** security updates reboot the server at 04:30 UTC when a
  kernel update needs it. Nothing to do.
- **Check after a restart:** `ssh daniel@hetzner-djh-v1 'uptime; docker ps; sudo ufw status | head -1'`
  and open `https://investments.daniel-henke.de`.

## Rebuild from scratch (about 30 minutes)

Use this when the server is broken beyond repair or you want a clean start. The
script does the heavy lifting; the steps below are the parts only you can do.

**Before you start**

- Once the v6 app is running: make sure the latest B2 backup is recent (procedure
  added in v6 Phase 2). Today the server holds no data, so nothing can be lost.
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
- Later in v6: the app's other secrets in `/opt/investments/.env` (documented in its
  `.env.example`).

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

`bootstrap.sh` is safe to re-run at any time; each step checks before it changes
anything.

## Updates

- **OS:** `unattended-upgrades` installs security updates daily and reboots at
  04:30 UTC when a kernel update needs it.
- **Manual catch-up** (rarely needed): `sudo apt-get update && sudo apt-get full-upgrade`,
  then `sudo reboot` if `/var/run/reboot-required` exists.
- **Containers:** the app image is updated by the deploy workflow (v6 Phase 2).

## Firewall note

Docker-published ports bypass `ufw`. Only the Caddy container publishes ports
(80/443, which are public anyway); app containers must never publish ports.

## Current state (Phase 0 checks)

- `caddy-check` container (Caddy 2.11) serves a placeholder `ok` page with a valid
  Let's Encrypt certificate, `X-Robots-Tag: noindex`, and redirects HTTP → HTTPS.
  It is replaced by the real stack in v6 Phase 2: `docker rm -f caddy-check`.
- yfinance one-shot from the server (2026-10-31): daily closes and 1-minute bars
  returned in under 2 s.
- All-day yfinance polling test: a throwaway job (`yf-spike.timer`, files in
  `/opt/investments/spike/`, not in this repo) runs on Monday 2026-11-02 during the
  US session. After the results are read, remove it:
  `sudo systemctl disable --now yf-spike.timer && sudo rm /etc/systemd/system/yf-spike.* && sudo systemctl daemon-reload && rm -rf /opt/investments/spike && docker rmi yf-spike:1`.
- B2 (2026-10-31): a bucket-scoped key in `~/b2.env` (mode 600) can upload, list,
  download and delete in `Investment-Overview`, and is refused when listing other buckets.

#!/usr/bin/env bash
# Turn a fresh Ubuntu LTS server (Hetzner Cloud) into a hardened Docker host.
#
# Safe to re-run: every step checks before it changes anything.
# Run as root. Steps are split so you can never lock yourself out:
#
#   bash bootstrap.sh                      # 1. base setup + admin user (root login still allowed)
#   LOCK_ROOT=1 bash bootstrap.sh          # 2. after "ssh <admin>@server" works: disable root/password login
#   CLOSE_PUBLIC_SSH=1 bash bootstrap.sh   # 3. after SSH over Tailscale works: SSH only via the tailnet
#
# Fallback if anything goes wrong: the Hetzner web console (">_" on the server page)
# always works, independent of SSH and the firewall.
set -euo pipefail

ADMIN_USER="${ADMIN_USER:-daniel}"
DEV_USER="${DEV_USER-dev}"   # set DEV_USER= (empty) to skip the Claude Code workspace user
SWAP_SIZE="${SWAP_SIZE:-2G}"
LOCK_ROOT="${LOCK_ROOT:-0}"
CLOSE_PUBLIC_SSH="${CLOSE_PUBLIC_SSH:-0}"

log() { printf '\n==> %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive

log "System packages"
apt-get update -qq
apt-get -y -qq upgrade
apt-get -y -qq install ca-certificates curl gnupg ufw unattended-upgrades jq git tmux

log "Automatic security updates (reboot at 04:30 UTC when a kernel update needs it)"
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
cat >/etc/apt/apt.conf.d/52unattended-upgrades-local <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF

log "Timezone UTC, journald capped at 200 MB"
timedatectl set-timezone Etc/UTC
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=200M\n' >/etc/systemd/journald.conf.d/size.conf
systemctl restart systemd-journald

log "Swap file (${SWAP_SIZE})"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l "$SWAP_SIZE" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi
echo 'vm.swappiness=10' >/etc/sysctl.d/90-swappiness.conf
sysctl -q -p /etc/sysctl.d/90-swappiness.conf

log "Admin user '${ADMIN_USER}' (SSH key copied from root, passwordless sudo)"
if ! id "$ADMIN_USER" &>/dev/null; then
  adduser --disabled-password --gecos "" "$ADMIN_USER" >/dev/null
fi
usermod -aG sudo "$ADMIN_USER"
install -d -m 700 -o "$ADMIN_USER" -g "$ADMIN_USER" "/home/$ADMIN_USER/.ssh"
install -m 600 -o "$ADMIN_USER" -g "$ADMIN_USER" /root/.ssh/authorized_keys "/home/$ADMIN_USER/.ssh/authorized_keys"
echo "$ADMIN_USER ALL=(ALL) NOPASSWD:ALL" >"/etc/sudoers.d/90-$ADMIN_USER"
chmod 440 "/etc/sudoers.d/90-$ADMIN_USER"
visudo -cq

log "Docker"
if ! command -v docker &>/dev/null; then
  . /etc/os-release
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  # Docker's repo can lag behind brand-new Ubuntu releases; fall back to Ubuntu's own packages.
  if curl -fsI "https://download.docker.com/linux/ubuntu/dists/${VERSION_CODENAME}/Release" >/dev/null; then
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
      >/etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get -y -qq install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  else
    echo "Docker repo has no '${VERSION_CODENAME}' yet; using Ubuntu's docker.io"
    rm -f /etc/apt/keyrings/docker.asc
    apt-get -y -qq install docker.io docker-compose-v2
  fi
fi
mkdir -p /etc/docker
[[ -f /etc/docker/daemon.json ]] || cat >/etc/docker/daemon.json <<'EOF'
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }
EOF
systemctl enable --now docker >/dev/null
systemctl restart docker
usermod -aG docker "$ADMIN_USER"

log "Tailscale (joining the tailnet is a separate, interactive step: sudo tailscale up)"
command -v tailscale &>/dev/null || curl -fsSL https://tailscale.com/install.sh | sh

if [[ -n "$DEV_USER" ]]; then
  log "Workspace user '${DEV_USER}' for Claude Code (same SSH key, no sudo, no docker)"
  # Claude Code works here, never as the admin user: sudo or the docker group would
  # let it reach the app stack, its data and the secrets in the admin's home.
  if ! id "$DEV_USER" &>/dev/null; then
    adduser --disabled-password --gecos "" "$DEV_USER" >/dev/null
  fi
  for group in sudo docker; do
    if id -nG "$DEV_USER" | grep -qw "$group"; then gpasswd -d "$DEV_USER" "$group" >/dev/null; fi
  done
  rm -f "/etc/sudoers.d/90-$DEV_USER"
  chmod 750 "/home/$ADMIN_USER"
  install -d -m 700 -o "$DEV_USER" -g "$DEV_USER" "/home/$DEV_USER/.ssh" "/home/$DEV_USER/projects"
  install -m 600 -o "$DEV_USER" -g "$DEV_USER" "/home/$ADMIN_USER/.ssh/authorized_keys" "/home/$DEV_USER/.ssh/authorized_keys"
  # Native installer: no Node needed; keeps itself up to date. Login is a separate,
  # interactive step (run `claude` as this user and open the printed link).
  sudo -u "$DEV_USER" -H bash -c '[[ -x ~/.local/bin/claude ]] || curl -fsSL https://claude.ai/install.sh | bash'
fi

log "Firewall (ufw): deny all incoming except web + SSH"
# Note: Docker-published ports bypass ufw. Only Caddy publishes ports (80/443), which
# are meant to be public anyway; app containers never publish ports.
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow in on tailscale0 >/dev/null
if [[ "$CLOSE_PUBLIC_SSH" == 1 ]]; then
  tailscale status &>/dev/null || { echo "Tailscale is not up; refusing to close public SSH" >&2; exit 1; }
  ufw delete allow 22/tcp >/dev/null 2>&1 || true
  echo "Public SSH closed: reach the server via Tailscale only."
else
  ufw allow 22/tcp >/dev/null
fi
ufw --force enable >/dev/null

log "SSH hardening"
if [[ "$LOCK_ROOT" == 1 ]]; then
  # 00- sorts before Ubuntu's 50-cloud-init.conf, and sshd keeps the first value it reads.
  cat >/etc/ssh/sshd_config.d/00-hardening.conf <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
  sshd -t
  systemctl reload ssh
  echo "Root and password login disabled."
else
  echo "Skipped (re-run with LOCK_ROOT=1 once 'ssh ${ADMIN_USER}@<server>' works)."
fi

log "Done"
printf 'docker:    %s\n' "$(docker --version)"
printf 'compose:   %s\n' "$(docker compose version 2>/dev/null || echo missing)"
printf 'tailscale: %s\n' "$(tailscale version | head -1)"
[[ -z "$DEV_USER" ]] || printf 'claude:    %s\n' "$(sudo -u "$DEV_USER" -H bash -c '~/.local/bin/claude --version' 2>/dev/null || echo missing)"
ufw status | sed 's/^/ufw:       /' | head -12

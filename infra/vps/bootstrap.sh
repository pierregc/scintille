#!/usr/bin/env bash
# Idempotent hardening of the Debian VPS. Run as: ssh debian@<host> 'sudo bash -s' < infra/vps/bootstrap.sh
set -euo pipefail

DEPLOY_USER=deploy
ADMIN_USER=debian

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get upgrade -yq
apt-get install -yq ufw fail2ban unattended-upgrades ca-certificates curl gnupg

timedatectl set-timezone UTC

# Non-root deploy user, same keys as the admin user.
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
	useradd --create-home --shell /bin/bash "$DEPLOY_USER"
fi
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
install -m 600 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$ADMIN_USER/.ssh/authorized_keys" "/home/$DEPLOY_USER/.ssh/authorized_keys"

# Key-only SSH; sorts before 50-cloud-init.conf, so these values win.
cat > /etc/ssh/sshd_config.d/10-scintille.conf <<CONF
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AllowUsers $ADMIN_USER $DEPLOY_USER
CONF
sshd -t
systemctl reload ssh

# Firewall: SSH only inbound.
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw --force enable

cat > /etc/fail2ban/jail.d/sshd.local <<CONF
[sshd]
enabled = true
backend = systemd
CONF
systemctl enable --now fail2ban
systemctl restart fail2ban

cat > /etc/apt/apt.conf.d/20auto-upgrades <<CONF
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF

# Docker Engine and Compose plugin from Docker's repository.
install -m 0755 -d /etc/apt/keyrings
if [ ! -f /etc/apt/keyrings/docker.asc ]; then
	curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
	chmod a+r /etc/apt/keyrings/docker.asc
fi
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list
apt-get update -q
apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
usermod -aG docker "$DEPLOY_USER"
systemctl enable --now docker

echo "bootstrap done"

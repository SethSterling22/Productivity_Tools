#!/usr/bin/env bash
# Run INSIDE the Debian LXC, AFTER GPU passthrough is configured on the Proxmox
# host and the matching NVIDIA userspace driver is installed in the LXC
# (so that `nvidia-smi` already works inside the container). See README.md.
#
# Installs Docker + the NVIDIA Container Toolkit, then you run the Whisper compose.
set -euo pipefail

echo "==> 1/4  Verifying the GPU is visible inside the LXC..."
if ! nvidia-smi; then
  echo "!! nvidia-smi failed inside the LXC."
  echo "   Install the NVIDIA userspace driver that MATCHES the host version"
  echo "   (see README §3) before running this script."
  exit 1
fi

echo "==> 2/4  Installing Docker CE..."
apt-get update
apt-get install -y ca-certificates curl gnupg git
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

echo "==> 3/4  Installing NVIDIA Container Toolkit..."
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  > /etc/apt/sources.list.d/nvidia-container-toolkit.list
apt-get update
apt-get install -y nvidia-container-toolkit
nvidia-ctk runtime configure --runtime=docker
systemctl restart docker

echo "==> 4/4  Testing GPU access from Docker..."
docker run --rm --gpus all nvidia/cuda:12.2.2-base-ubuntu22.04 nvidia-smi

cat <<'NEXT'

Done. Now start Whisper (GPU) inside the LXC:

  git clone https://github.com/SethSterling22/Productivity_Tools.git /root/Productivity_Tools
  cd /root/Productivity_Tools/voice-services/whisper
  docker compose -f docker-compose.gpu.yaml up -d --build

Then from Ocra, point Rebeca at this LXC:
  WHISPER_URL=http://<lxc-tailscale-or-lan-ip>:8100    (in ~/Productivity_Tools/n8n/.env)
NEXT

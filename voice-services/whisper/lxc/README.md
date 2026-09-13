# Whisper on Sadida via LXC + Docker (GPU passthrough)

The Proxmox-native way: a Debian LXC with the GPU passed through, running Docker +
the portable GPU compose (`../docker-compose.gpu.yaml`). Keeps the host clean and
is reusable/reproducible.

Two alternatives, both provided:
- **This LXC route** (below).
- **Plain Docker on any GPU host** — just `../docker-compose.gpu.yaml` where Docker
  + NVIDIA Container Toolkit already work.

> GPU passthrough to an LXC is environment-specific. Verify device majors and match
> the driver version to your host. Do each step and check `nvidia-smi` before moving on.

## 1. Create the LXC (on the Proxmox host)

A privileged Debian 12 container is simplest for GPU passthrough:

```bash
# adjust storage, template, size, id (900) to your setup
pct create 900 local:vztmpl/debian-12-standard_*_amd64.tar.zst \
  --hostname whisper-gpu --cores 4 --memory 4096 --rootfs local-lvm:16 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp --features nesting=1 --unprivileged 0
```

`nesting=1` is needed to run Docker inside the LXC.

## 2. GPU passthrough (edit the LXC config on the host)

Find the NVIDIA device majors on the host:

```bash
ls -l /dev/nvidia*            # note the major numbers (e.g. 195, 508, 511...)
cat /proc/devices | grep -i nvidia
```

Edit `/etc/pve/lxc/900.conf` and append (adjust majors to what you saw above):

```
# --- NVIDIA GPU passthrough ---
lxc.cgroup2.devices.allow: c 195:* rwm
lxc.cgroup2.devices.allow: c 508:* rwm
lxc.cgroup2.devices.allow: c 511:* rwm
lxc.mount.entry: /dev/nvidia0 dev/nvidia0 none bind,optional,create=file
lxc.mount.entry: /dev/nvidiactl dev/nvidiactl none bind,optional,create=file
lxc.mount.entry: /dev/nvidia-uvm dev/nvidia-uvm none bind,optional,create=file
lxc.mount.entry: /dev/nvidia-uvm-tools dev/nvidia-uvm-tools none bind,optional,create=file
lxc.mount.entry: /dev/nvidia-caps dev/nvidia-caps none bind,optional,create=dir
```

(195 = `nvidia`; the uvm/caps majors are dynamic — use the ones from step above.)

Start it: `pct start 900` and enter: `pct enter 900`.

## 3. Matching NVIDIA userspace driver INSIDE the LXC

The LXC uses the host's kernel module, so install only the **userspace** driver, and
it must match the host version. Check the host: `cat /proc/driver/nvidia/version`
(yours: `615.71.09`).

Install the same version in the LXC **without** the kernel module. Easiest is the
NVIDIA `.run` installer for that version with `--no-kernel-modules`, or the same
Debian packages the host uses. After installing, verify:

```bash
nvidia-smi     # inside the LXC — must show the GPU before continuing
```

If `nvidia-smi` works in the LXC, passthrough + driver match are correct.

## 4. Docker + NVIDIA Container Toolkit + Whisper

Copy `provision-inside-lxc.sh` into the LXC and run it (installs Docker + toolkit,
tests GPU in Docker):

```bash
bash provision-inside-lxc.sh
```

Then start Whisper:

```bash
git clone https://github.com/SethSterling22/Productivity_Tools.git /root/Productivity_Tools
cd /root/Productivity_Tools/voice-services/whisper
docker compose -f docker-compose.gpu.yaml up -d --build
curl http://localhost:8100/health      # "device":"cuda"
```

## 5. Point Rebeca at the LXC (on Ocra)

The LXC needs to be reachable from Ocra. Easiest: install Tailscale in the LXC
(`curl -fsSL https://tailscale.com/install.sh | sh && tailscale up`) so it gets a
MagicDNS name; or use its LAN IP if Ocra can route to it.

In `~/Productivity_Tools/n8n/.env`:
```
WHISPER_URL=http://<lxc-name-or-ip>:8100
```
```bash
cd ~/Productivity_Tools/n8n
sudo docker compose up -d --force-recreate --no-deps assistant-core
sudo docker compose stop whisper     # the Ocra CPU whisper is no longer used
```

## Notes

- VRAM: `small` (~1 GB) + qwen3:1.7b (~1.8 GB) fits in 4 GB. Set `WHISPER_MODEL=base`
  if you hit CUDA OOM.
- If `nvidia-smi` fails in the LXC: recheck the device majors and that the LXC driver
  version equals the host's exactly.
- Unprivileged LXCs also work but need idmap for the device nodes (more setup);
  privileged is simpler for a homelab GPU box.

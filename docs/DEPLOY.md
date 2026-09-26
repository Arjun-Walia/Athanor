# Deploying Athanor on an Oracle Cloud VPS

This is how www.athanor.cfd runs: one Oracle Cloud Infrastructure (OCI)
compute instance, five `vault-node` processes on it, a Caddy gateway that
health-checks them, and a Cloudflare Tunnel that exposes the gateway on the
public hostname. No inbound port on the VPS is opened to the internet; the
tunnel dials out.

The same steps work on any Ubuntu VPS. The Oracle-specific notes are
marked.

## 1. The instance

- Shape: an Always Free `VM.Standard.A1.Flex` (Ampere, arm64) with 2 OCPUs
  and 6 GB is plenty; the AMD `VM.Standard.E2.1.Micro` works too. The
  five nodes together use well under 500 MB of RAM at rest.
- Image: Ubuntu 24.04 (Canonical). The default user is `ubuntu`.
- Boot volume: 50 GB is enough. Object data lives under the checkout in
  `data/local/`, one directory per node.
- Networking: only SSH (22) needs to be reachable. Because the tunnel dials
  out, you do **not** need to open 80, 443, 8080, 9090 or 7946 in the VCN
  security list or in the instance firewall.

> **Oracle note.** OCI's Ubuntu images ship with iptables rules that drop
> everything except SSH, in addition to the VCN security list. If you ever
> expose the gateway directly (without the tunnel), you must allow the port
> in *both* places:
>
> ```bash
> sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 8080 -j ACCEPT
> sudo netfilter-persistent save
> ```
>
> and add an ingress rule for TCP 8080 to the subnet's security list in the
> OCI console. With the tunnel, skip this.

## 2. Tooling

```bash
sudo apt update && sudo apt install -y git make curl build-essential debian-keyring debian-archive-keyring apt-transport-https

# Go 1.25 (pick the arch that matches the shape: arm64 for A1, amd64 for E2)
curl -fsSL https://go.dev/dl/go1.25.0.linux-$(dpkg --print-architecture).tar.gz | sudo tar -C /usr/local -xz
echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.profile && source ~/.profile

# Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs

# Caddy
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
sudo systemctl disable --now caddy   # public-up.sh runs its own caddy with deploy/Caddyfile.host

# cloudflared
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install -y cloudflared
```

## 3. The tunnel

In the Cloudflare dashboard (Zero Trust → Networks → Tunnels) create a
tunnel, add a public hostname `www.athanor.cfd` → `http://localhost:8080`,
and copy the tunnel token. On the VPS:

```bash
mkdir -p ~/.cloudflared
printf '%s' '<tunnel token>' > ~/.cloudflared/athanor.token
chmod 600 ~/.cloudflared/athanor.token
```

If the hostname later shows Cloudflare error **1033**, the tunnel has no
live connector: `cloudflared` is not running on the VPS.

## 4. The checkout and its secrets

```bash
git clone https://github.com/Arjun-Walia/Athanor.git ~/Athanor
cd ~/Athanor
make ui-build                     # dashboard + landing page into ui/dist
cp deploy/athanor.env.example deploy/athanor.env
```

Edit `deploy/athanor.env`:

- `PUBLIC_URL` is the origin visitors use.
- `ATHANOR_ADMIN_TOKEN` makes writes and admin actions require a bearer
  token. The public demo runs without one on purpose so visitors can press
  the buttons; set it if the cluster holds anything you care about.
- `ATHANOR_CLUSTER_SECRET` encrypts gossip and authenticates peer RPC. On a
  single machine it is optional; set it before a second machine joins.

`scripts/public-up.sh` sources this file, so nothing secret goes on a
command line or into git (`deploy/athanor.env` is ignored).

## 5. Start it, and keep it started

Once, by hand, to see the output:

```bash
scripts/public-up.sh
curl -s http://127.0.0.1:8080/v1/admin/ready
curl -s https://www.athanor.cfd/v1/admin/health | head -c 200
```

Then as a service so it survives reboots:

```bash
sudo cp deploy/systemd/athanor.service /etc/systemd/system/
# adjust User= and the two paths if the checkout is not /home/ubuntu/Athanor
sudo systemctl daemon-reload
sudo systemctl enable --now athanor
systemctl status athanor
```

The unit runs `public-up.sh` at boot (with `REBUILD=0`, so it uses the
binary already built) and `public-down.sh` on stop. Node, gateway and
tunnel logs are under `data/local/run/*.log`.

## 6. Updating

```bash
cd ~/Athanor && git pull
make ui-build
scripts/public-down.sh
REBUILD=1 scripts/public-up.sh     # rebuilds vault-node with the new UI embedded
```

Or `sudo systemctl restart athanor` after `git pull && make ui-build` if the
unit runs with `REBUILD=1`. The nodes come back with their data, the
persisted N/W/R policy, and their clock high-water marks; the in-memory
event log starts empty.

## 7. Checking it

| What | Command |
| --- | --- |
| Every node ready | `for p in 8081 8082 8083 8084 8085; do curl -s localhost:$p/v1/admin/ready; echo; done` |
| Gateway rotation | `curl -sI localhost:8080/v1/admin/health \| grep -i x-athanor-node` (repeat; the node changes) |
| Public origin | `curl -s https://www.athanor.cfd/v1/admin/cluster \| python3 -m json.tool \| head -30` |
| Event stream | `curl -sN --max-time 5 https://www.athanor.cfd/v1/admin/events/stream` |
| Disk per node | `du -sh data/local/node*` |

## 8. Backups and growth

Each node's `data/local/nodeN/` directory is self-contained (blobs, hints,
`index.db`). Copy it while the node is stopped, or rely on the other two
replicas: any object survives losing two of its three owners' disks.

A second VPS joins by running `vault-node` with `--advertise` set to an
address the first machine can dial, `--seeds` set to an existing node's
gossip address (`host:7946`), and the same `ATHANOR_CLUSTER_SECRET`. Gossip
is TCP and UDP 7946, peer gRPC is TCP 9090; open both between the machines
(VCN security list and iptables, see the Oracle note) and nowhere else.

# Security

Athanor is a demo cluster first. This page says exactly what it protects,
what it does not, and how to turn the protections on.

## What is on by default

- **Integrity.** Every replica is stored with its SHA-256 and re-hashed on
  every read and on every scrub pass. Bytes that do not match are never
  served and are rewritten from a verified copy.
- **Bounded resources.** Uploads are capped at 64 MiB, at most 32 object
  bodies are held in memory per node (the rest get `503` with
  `Retry-After`), HTTP has header, body and idle timeouts, and a panic in
  one request or one peer RPC answers an error for that call only.
- **Browser hardening.** The pages ship a Content-Security-Policy, refuse
  framing, and set `X-Content-Type-Options: nosniff`. The desktop app runs
  the renderer sandboxed with context isolation, no Node integration, and
  opens external links in the system browser.
- **Dependencies.** CI runs `govulncheck` on the Go module and `npm audit`
  on both JavaScript trees; the build fails on a known high-severity issue.

## What is opt-in

| Flag | What it does |
| --- | --- |
| `--admin-token` | Every request that changes anything (object writes and deletes, stop, start, corrupt, partition, policy) needs `Authorization: Bearer <token>`. Reads, the dashboard and the event stream stay open. Compared in constant time. Nodes pass the token along when they forward an admin action to a peer. |
| `--cluster-secret` | Gossip is encrypted with AES-GCM (memberlist's keyring) and every peer RPC must carry the secret in its metadata. A process that does not know the secret cannot join the ring, read membership, or call a node. |
| `--tls-cert` / `--tls-key` | Serve the client and admin HTTP API over TLS. Peer gRPC stays on the private network. |

Every flag has an `ATHANOR_*` environment twin; that is the right way to
hand a secret to a container or a systemd unit. A node whose public URL is
not localhost and that has no admin token logs a warning at start.

## What is not there

- **No per-user authorization.** One token, all or nothing.
- **No TLS on peer gRPC or gossip.** The cluster secret authenticates and
  encrypts gossip; gRPC payloads between nodes are authenticated but not
  encrypted. Keep the peer ports (9090, 7946) on a private network.
- **No audit trail.** The event log is in memory and bounded.
- **The public demo runs open on purpose** so visitors can stop nodes and
  flip bytes. Do not store anything you care about on it.

## Reporting

Open a private security advisory on the GitHub repository, or email the
maintainer listed in `desktop/package.json`. Please include the version
from `vault-node --version`.

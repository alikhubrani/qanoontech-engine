# QanoonTech Engine

The control plane for a QanoonTech deployment. It installs the system, updates
it, configures it, turns optional modules on and off, takes and restores
backups, and enforces the licence.

**Status: design only.** Nothing here is built yet. The plan is
[`docs/design.md`](docs/design.md), and it is the specification — read that
first.

---

## What it does not do

This repository is public so that a firm's security reviewer can check these
claims rather than take them on trust. They are structural, not policy.

- **It never handles user traffic.** No request from a lawyer or a client
  reaches it.
- **It never reads a client document.** No route touches the uploads volume.
- **It never runs SQL.** Backup and restore shell out to `pg_dump` and `psql`
  over whole files. Nothing selects rows.
- **It never runs `docker exec`.** This is the boundary that matters most —
  `exec` into the database container is a complete client-data dump.
- **It is never published to the internet.** Bound to `127.0.0.1` by default.

## What it does hold

Stated plainly rather than dressed up: **the engine holds the Docker socket,
which is root on the host.** It needs it to create containers, and there is no
narrower grant that permits that — `/containers/create` accepts arbitrary bind
mounts, so any proxy configuration sufficient for our purpose is already
root-equivalent. A socket proxy in that position would claim a property the
deployment does not have.

What limits the engine is the shape of its own code: every container operation
resolves against a fixed catalogue, and a name the catalogue does not define is
rejected before it reaches Docker. That is auditable, and it is in this
repository.

## Installing

One command, then a browser. The engine image is public and needs no credential
to pull, which is what makes it the first step rather than the second.

```bash
docker run -d --name qanoontech-engine \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v qanoontech_engine:/var/lib/qanoontech-engine \
  -p 127.0.0.1:8081:8080 \
  ghcr.io/alikhubrani/qanoontech-engine:latest
```

Everything after that happens at `http://127.0.0.1:8081/`: licence, registry
token, preflight checks, version, configuration, modules, deploy.

## Licence

QanoonTech is commercial software. A deployment requires a signed licence, and
the engine verifies it. See
[Licensing](docs/design.md#licensing) for what that means in practice, including
what happens when a licence lapses — and, more to the point, what does not: your
data stays intact, your backups keep running, and you can always get your
records out.

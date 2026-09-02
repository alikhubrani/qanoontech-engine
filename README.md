# QanoonTech Engine

The control plane for a QanoonTech deployment. It installs the system, updates
it, configures it, turns optional modules on and off, takes and restores
backups, and enforces the licence.

**Status: phase 1.** The module catalogue, resolution, the compose renderer and
the command line exist and are tested. There is no web interface yet, no
licence verification yet, and no backups yet — see
[Phasing](docs/design.md#phasing). The plan is
[`docs/design.md`](docs/design.md), and it is the specification: read that
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

## Working on it

```bash
npm install
npm run type-check
npm test
ENGINE_STATE_DIR=./.state npm run engine -- status
```

The command line is not a stopgap for the web interface. The renderer is the
part that can be wrong in ways a UI hides — a bad compose file looks like a
working button — so it is driven from here first, where a bad render is a diff
you can read. Afterwards it stays: it is what `rescue.sh` and CI use, and it is
how a deployment is worked on when the browser path is the thing that broke.

```
engine status                      what this deployment is configured to be
engine modules                     the catalogue, and what is on
engine enable <module>             turn an optional module on
engine config <module> '<json>'    set a module's configuration
engine version <version>           choose the QanoonTech version
engine secrets init                generate any missing secret
engine render --stdout             render the compose file
engine apply                       render, check, pull, bring it up
engine logs <service>              recent output from one service
```

## Licence

QanoonTech is commercial software. A deployment requires a signed licence, and
the engine verifies it. See
[Licensing](docs/design.md#licensing) for what that means in practice, including
what happens when a licence lapses — and, more to the point, what does not: your
data stays intact, your backups keep running, and you can always get your
records out.

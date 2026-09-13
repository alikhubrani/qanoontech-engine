# QanoonTech Engine — design

**Status: all five phases built and proven on the staging box (2026-09-02). Remaining: the OCR module image (application-repository work). Licensing was removed from the engine on 2026-09-12. The offsite backup copy is built and running on R2; the Drive mirror was retired on 2026-09-12 — see below.** This document is the decision
record and the plan. Where it states a decision, that decision was made
deliberately and the alternative is written down next to it, so that changing
course later is an argument with a known cost rather than a rediscovery.

---

## What this is

The engine is the control plane for a QanoonTech deployment. It is the only
thing a firm's box needs before it has anything else: it installs QanoonTech,
updates it, configures it, turns optional modules on and off, takes and restores
backups.

It is not part of the application. It never serves user traffic, never reads a
client document, and never runs SQL against the firm's database. Everything it
does is deployment state — which containers exist, what version they are, what
credentials they hold, whether they are healthy.

**One box, one firm, one engine.** There is no multi-tenancy here. The
multi-firm surface was the licence service, a separate component and
runs on our side, not theirs.

### The line, stated once

| | engine | application |
| --- | --- | --- |
| owns | whether a thing is **deployed** | whether a feature is **visible to users** |
| holds | images, versions, credentials, container lifecycle | cases, clients, documents |
| knows about modules | everything: image, cost, config, health | only whether one **answers** |
| storage | its own volume | Postgres + uploads |
| reachable | the box's LAN on `:8081`, never routed further | through nginx, the LAN, and the tunnel |

The application never stores a second copy of deployment state. It derives it.
See [Modules](#modules) for why that sentence is the most important one in this
document.

---

## Prior art

Four systems solve pieces of this under the same constraint we have — the
vendor cannot reach the customer's machine. What we took from each, and what we
deliberately did not.

**[Nextcloud AIO](https://github.com/nextcloud/all-in-one)** is the closest
architectural match: a mastercontainer that installs and manages every other
container, with a web interface that is the only install path. Two properties
are copied verbatim — *the control plane never handles user traffic or user
data*, and *its interface is not exposed publicly*. Its container definitions
live in a declarative `containers.json` validated against a schema, and optional
services (Talk, ClamAV, Collabora, Imaginary, fulltextsearch) are simply
filtered out of that list when disabled. That filtering model is exactly what we
want for PaddleOCR.

What we did **not** take: AIO creates containers over the Docker API directly.
See [Why generated compose](#why-generated-compose-and-not-the-docker-api).

**[Home Assistant Supervisor](https://developers.home-assistant.io/docs/add-ons/)**
— add-ons are containers with a **declared options schema**, and the Supervisor
type-checks, range-checks and format-checks every option before starting one.
Our module catalogue carries the same idea: a module that cannot describe its
own configuration cannot be shipped.

**[Replicated KOTS](https://docs.replicated.com/intro-kots)** — the reference
for what an on-prem admin console is expected to contain:
a configuration screen, **preflight checks** before install, version history,
and **support bundles** with redaction on by default. Preflight and support
bundles are both adopted; see [Diagnostics](#diagnostics).

**[CasaOS](https://github.com/IceWhaleTech/CasaOS-AppStore) /
[Runtipi](https://runtipi.io/docs/learn/apps-and-app-store)** — compose-per-app
stores where a user can install anything. Read as a warning, not a model: an
open catalogue turns the engine into a general container manager whose security
we then own, on a box holding privileged legal records. See
[Scope limits](#scope-limits).

---

## Architecture

### The catalogue is the source of truth

Every service in a deployment — the application itself, Postgres, nginx, and
every optional module — is declared once, in the engine's code, as a module
definition:

```ts
{
  id: 'ocr',
  image: 'ghcr.io/alikhubrani/qanoontech-ocr',
  optional: true,
  defaultEnabled: false,
  cost: { image: '~2 GB', memory: '2G', cpus: '2' },
  requires: ['app'],
  config: OcrConfigSchema,        // validated before the module can start
  volumes: [...],
  health: { ... },
}
```

Enabled state, configuration values and secrets live on the engine's own volume,
never in the repository and never in the application's database.

### Rendering

The engine renders `docker-compose.generated.yml` from the catalogue filtered by
what is enabled, then runs `docker compose up -d`. Every container operation —
`apply`, `pull`, `start`, `stop`, `restart`, `logs` — goes through one internal
interface. Route handlers never invoke compose and never touch the socket
directly.

```
catalogue (code)  ─┐
enabled state     ─┼─►  render  ─►  docker-compose.generated.yml
config + secrets  ─┘                        │
                                    docker compose up -d
```

#### Why generated compose, and not the Docker API

AIO talks to the Docker API directly and it works. We are choosing compose
anyway, for one reason that outweighs the flexibility: **when the engine is
broken, the box must still explain itself.** A generated compose file on disk
can be read, diffed against the previous one, and run by hand over SSH by
someone who has never seen this codebase. A `DockerActionManager` leaves nothing
behind — the one artefact that tells you what the deployment *is* only exists
while the thing that failed is running.

Secondary: compose already gives us dependency ordering, health gating,
`--remove-orphans` and `docker compose ps`. Writing those ourselves is work with
no product in it.

The cost is real and worth naming: compose is a middleman, some things are
awkward through it, and we inherit its semantics. If that becomes the binding
constraint, the internal interface above is what makes switching a swapped
implementation rather than a rewrite. Do not let compose invocations leak out of
it.

#### Secrets in the rendered file

The renderer currently writes secrets into the file as environment variables,
which is how the existing deployment's `.env` works too — and it has the known
weaknesses: values visible in `docker inspect`, present in the environment of
every process in the container, and one careless log line from leaking. The
better mechanism is compose file-based secrets mounted at `/run/secrets/`,
read through the `_FILE` convention.

The move is phased because it is not free: the official Postgres image
understands `POSTGRES_PASSWORD_FILE` today, but the application reads plain
environment variables and has to learn `_FILE` first. Until then the rendered
file is mode `0600` on the engine's volume, which is no worse than the `.env`
it replaces — but "no worse than before" is a starting point, not a
destination. Postgres moves first; the application follows when it can.

### Docker access

The engine holds the Docker socket. That is root on the host, and it is stated
plainly in the README rather than dressed up.

A [socket proxy](https://github.com/Tecnativa/docker-socket-proxy) is not used,
because it would narrow nothing: the engine needs `docker compose up -d` to
create containers, and `/containers/create` accepts arbitrary bind mounts, so
any grant sufficient for our purpose is already root-equivalent. A proxy in that
position is a component whose comment claims a property the deployment does not
have.

What limits the engine instead is the shape of its own code, and this is the
part a security reviewer should check:

- **No `docker exec`, ever.** This is the boundary that matters most — `exec`
  into Postgres is a complete client-data dump, and nothing else on the
  capability list comes close.
- **No route reads `uploads/`.**
- **No SQL.** Backup and restore shell out to `pg_dump` and `psql` over whole
  files. Nothing selects rows.
- **No free-form container names.** Every operation resolves against the
  catalogue; a name the catalogue does not define is rejected before it reaches
  Docker.

### Self-update

A container cannot cleanly replace itself. When the engine changes its own
pinned version it spawns a short-lived helper container that performs the swap
and exits — the pattern AIO uses, where a pinned Watchtower binary baked into
the image is run once with `CONTAINER_TO_UPDATE`. Well-trodden, but it is real
work; it is scheduled in [phase 4](#phasing), not assumed to be free.

---

## Modules

A module is an optional service the firm can turn on. Off by default — a
feature behind a toggle is one nobody has committed to yet, and the resource
cost is real: PaddleOCR is roughly 2 GB of image most firms will never enable.

The catalogue is **closed**. It is a fixed, versioned list we build, test and
support; a new module ships with an engine release. No arbitrary containers, no
user-supplied compose. This is what makes "every enabled combination is one we
have actually run" a true statement.

### The application derives, it does not store

This is the sentence to hold on to: **the application never stores a second copy
of module state.** It discovers capability at runtime — OCR is available because
the sidecar answers. The engine
starts a container; the application notices.

The alternative — the engine writing a flag the application caches — is how a
system ends up with two catalogues that disagree and a UI showing the wrong
thing. It is worth paying a small capability-probe layer to make that
structurally impossible rather than merely discouraged.

Concretely:

```
ENGINE                              APPLICATION
  is it deployed?                     does it answer?
  credentials                         (probe / health)
  resource cost                       never persists the answer
      │                                     ▲
      └──────── starts container ───────────┘
```

### Initial catalogue

| module | what | cost | notes |
| --- | --- | --- | --- |
| `app` | QanoonTech application | required | not optional; in the catalogue so it is rendered the same way |
| `postgres` | database | required | pinned to a major version, never moved by an update |
| `nginx` | reverse proxy | required | |
| `ocr` | PaddleOCR sidecar | ~2 GB | today OCR is `tesseract` + `pdftoppm` **inside** the application container; this is a new sidecar, not a move |
| `email` | mailer: reminders and hearing changes over the firm's SMTP relay | ~180 MB | drains an outbox table the application writes; the application never holds SMTP credentials |
| `tunnel` | Cloudflare tunnel | ~40 MB | the only inbound path |

### Google Drive — retired (2026-09-12)

This section described one switch — "copy our things to our Google Drive" —
behind which sat two genuinely different jobs: a **document mirror** (thousands
of small files, continuously, read back by the application per document) and
the engine's **backup copy** (one set a night, read back by the engine as a
whole during a restore). They shared a service-account key and nothing else,
deliberately, because the backup exists to work when the application does not.

Both are gone. The backup copy goes to S3-compatible object storage instead
(`backup/s3.ts`, `backup/store.ts`), and the `drive-mirror` module and its
container are removed from the catalogue.

**Why object storage won.** A bucket takes lifecycle rules and object lock; a
Shared Drive takes neither, and object lock is the only thing on either side
that defends a backup against ransomware or against this engine being
compromised. Drive also cost a hand-rolled JWT, a folder tree walked per file
to fake a flat keyspace, and an OAuth credential with a wider blast radius than
a scoped bucket key.

**What replaced the mirror.** Nothing, and that is the point: the mirror
existed so the firm had a browsable second copy of their documents, and the
engine now copies documents to the bucket itself, under `documents/`, next to
`backups/`. One destination, one credential, one thing to check.

**Removing it safely.** `backupOffsiteProvider` and `backupOffsiteDriveId` were
dropped from the settings schema rather than deprecated in it. A state file
still carrying them parses without complaint because the schema is not strict
and silently drops what it does not name — which is what keeps a deployment
that was set to Drive from failing to boot on the release that removes it.

---

## Licensing — removed 2026-09-12

This section described a three-layer model: a signed Ed25519 licence saying what
is enabled and until when, a heartbeat asking whether it had been revoked, and
enforcement acting on the verdict. It was built, and it worked.

It is gone from the engine. `LICENCE_ENFORCED` had been `false` for some time —
everything ran except the part that acted — so 879 lines plus touches in
nineteen files were computing a conclusion nothing used, and a single-tenant
product installed by its own author was carrying a per-deployment token
ceremony. Every module in the catalogue is now available to every deployment;
`optional` means a firm chooses whether to run it, never that it can be
withheld.

The full design, the reasoning behind each decision, and what bringing it back
would require are in
[`archive-licence-implementation.md`](./archive-licence-implementation.md). The
wire format is in
[`archive-licence-protocol.md`](./archive-licence-protocol.md). The signing
service (`qanoontech-licence`) is untouched and still holds the key pair, and
both boxes still hold valid tokens, so the way back does not start from nothing.

One line from it is worth keeping in front of whoever reads this file, because
it is a rule about more than licensing:

> Stored conclusions are conclusions that can disagree with their inputs.


## Bootstrap

One command, then a browser.

```bash
docker run -d --name qanoontech-engine \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v qanoontech_engine:/var/lib/qanoontech-engine \
  -p 8081:8080 \
  ghcr.io/alikhubrani/qanoontech-engine:latest
```

The engine image is public and needs no credential to pull, which is what makes
this the first step rather than the second. Everything after it happens at
`http://<the box's address>:8081/`, from any machine on the firm's network:

```
licence  →  registry token  →  preflight  →  version
   →  configure  →  choose modules  →  deploy
```

A firm's first experience is a wizard, not a bash script, and the GHCR token is
typed into a form rather than pasted into a terminal.

### `rescue.sh`

A minimal shell script stays, for exactly one situation: the engine itself will
not start. It can pull, write a compose file and bring the stack up without the
engine's involvement. It matters more here than it would elsewhere, because the
engine holds the backups and can stop the stack — a bricked engine must not be a
bricked firm.

It is a recovery path, not a second supported way to install. It does not
configure modules and it does not touch licensing.

---

## Diagnostics

### Preflight

Conformance checks run before install and re-runnable afterwards. Failures are
either **warning** (proceed with acknowledgement) or **blocking**.

| check | blocking? |
| --- | --- |
| Docker Engine present, Compose v2 available | blocking |
| Daemon API version within the range our images negotiate | blocking |
| Free disk for uploads, backups and the database | blocking below a floor, warning below comfort |
| RAM and CPU against the resource limits of enabled modules | warning |
| Bind address and chosen ports free | blocking |
| Registry reachable, credential valid for every image we will pull | blocking |
| Licence present, signature valid, not expired | blocking |
| Existing volumes present — install, or re-install over live data? | blocking without acknowledgement |
| Clock skew against a known source | warning — licence and JWT validity depend on it |

The registry check earns its place twice over: it is where a wrong or expired
token is diagnosed by name, instead of surfacing four steps later as
`manifest unknown`.

### Support bundle

The box is unreachable by us by design, so the only diagnostic channel is
something the firm downloads and chooses to send. Nothing leaves the deployment
unless they send it.

**Collect:** container logs (bounded), image tags and digests, health history,
the generated compose file, disk and volume sizes, database size and migration
state, preflight results, engine audit log, licence status.

**Never collect:** anything under `uploads/`, any database row, any log line
carrying a document or client name.

**Redaction is not a checkbox.** Redactors run by default over every secret key
name, and the redactor list is unit-tested against the actual configuration
schema — so adding a secret without redacting it fails a test rather than
shipping.

---

## Security requirements

The repository is public. That does not weaken the design, but it does mean the
design has to hold with the attacker having read it.

1. **Never on the public internet.** Deployments are **LAN-open by design**
   (decided 2026-09-02, reversing an earlier default of `127.0.0.1`): the
   application and the panel serve the box's own network out of the box, and
   nothing routes them further unless the firm does so deliberately. A firm
   fronting the system with the Cloudflare tunnel narrows the bind address in
   settings at that point — reachability is a configuration, not a rail.

   Binding was never the boundary anyway. A malicious page in a browser can
   rebind a domain it controls to any address and script requests against
   whatever listens there. So the engine **validates the `Host` header**: an
   IP literal is always acceptable — the rebinding attack arrives under the
   attacker's *domain*, because a domain resolving here is the whole attack —
   while domain names must be ones the engine was told it serves. Session
   cookies are `HttpOnly` and `SameSite=Strict` (a rebound request carries no
   cookie), `Origin` is checked on every state-changing request, and every
   endpoint requires authentication; nothing trusts the network for being
   local.
2. **Real brute-force protection.** Server-side throttle in durable state with
   progressive delay or temporary lockout, reset on success
   ([OWASP](https://owasp.org/www-community/controls/Blocking_Brute_Force_Attacks)).
   Durable matters: an in-memory counter resets on container restart, and this
   container restarts often.
3. **TOTP, optional.** The difference between one secret and two for the account
   that can restore a database.
4. **No exec, no uploads, no SQL** — see [Docker access](#docker-access).
5. **Audit log.** Logins, updates, restores, config changes, module toggles,
   licence events. A law firm will be asked this by its own auditors.
6. **Secrets never in the repository.** Licence signing keys, registry
   credentials and service account keys live on the engine's volume or in our
   infrastructure.
7. **The engine's own container is hardened.** `no-new-privileges`, a
   read-only root filesystem with a tmpfs for scratch, no capabilities it does
   not use. It holds the socket, so a compromise is root regardless — the
   hardening is not about containing that, it is about denying a foothold: a
   bug in the panel should not hand an attacker a writable filesystem to
   persist in.
8. **Sessions follow OWASP.** Tokens of at least 64 bits of entropy,
   regenerated on login, invalidated server-side on logout, and a short idle
   timeout — this is an administrative console, not a mail client.

---

## Scope limits

Do not rebuild Portainer. Logs, start, stop and restart **for the services this
deployment defines** are cheap and useful. A general Docker management UI is
months of work, already exists, and would hand a firm's IT contractor a
root-equivalent console we then own the security of.

The boundary: services in the catalogue, nothing else on the host.

---

## Interface

English only. The Arabic-first rule governs the application, where the users are
lawyers and staff; the engine's user is whoever administers the box, and its
vocabulary is Docker, versions and backups.

One cheap precaution: keep user-facing strings in a single module rather than
inline in JSX. No `t()`, no key catalogue — just do not scatter the English.
It makes Arabic a week's work instead of a month's if a firm asks.

The pages and what each is for are in `docs/panel.md` (Phase 6, 2026-09-13),
which replaced the table that used to sit here — it listed a Licence page and
an engine password, both gone.

**Stack.** Vite + React + TypeScript + Tailwind + shadcn/ui, built to static
files, inheriting the application's design tokens so it reads as the same
product. Back end: a real framework, a session library, a validation library, a
logger, a Docker client — the hand-rolled equivalents are the parts most likely
to hold a bug and the least valuable to own. `pg_dump` and `psql` stay
subprocesses; a Postgres driver in the engine would put a SQL connection in a
component that is forbidden one.

The image stays small and boots fast. It is the thing a firm opens precisely
when everything else is broken.

---

## Phasing

Each phase is independently shippable and verifiable on a staging box before the
next begins.

| phase | what | done when |
| --- | --- | --- |
| **1** *(built, proven on the staging box)* | Catalogue, renderer, container interface, compose generation. CLI only, no UI | a stack can be brought up and down from the catalogue alone |
| **2** *(built, proven on the staging box)* | Web UI: Overview, Services, logs, start/stop/restart. Auth, throttle, audit log | an operator runs the deployment from a browser |
| **3** *(built and proven on the staging box — enforcement fired and cleared; the licence service itself is not built)* | Licence: format, offline verification, heartbeat client, grace state machine, enforcement, offline override | enforcement fires correctly on a test box and clears with a new licence |
| **4** *(built and proven on the staging box, self-update included; the update flow's backup step waits on phase 5)* | Bootstrap wizard, preflight, versions and rollback, self-update, `rescue.sh` | a clean box goes from one `docker run` to a running firm in a browser |
| **5** *(built and proven on the staging box: a restore completed end to end through the API, a marker row travelling back with it. The offsite copy now runs against R2; the Drive mirror was retired rather than extracted. Outstanding: the OCR image, which is application-repository work)* | Modules: PaddleOCR sidecar, tunnel. Backups, restore, offsite. Support bundle | modules can be enabled and disabled, and a restore completes without a terminal |

The licence service is built alongside phase 3 and lives in its own repository.

---

## Open questions

- **Air-gapped installs.** Replicated treats this as first-class. Nothing in the
  Saudi market has asked yet, but a government or bank-adjacent client would —
  and it is fundamentally incompatible with a required heartbeat. If that client
  appears, the licence layer needs an offline mode, and it is better to know the
  shape of it before selling to them.
- **Restore verification.** A weekly automated restore into a scratch database,
  with the result on the Overview page. Nobody in this category does it, and it
  is the gap most worth closing — an untested backup is a belief, not a backup.
- **Seat enforcement.** The licence carries a seat limit. Nothing yet decides
  what happens when a firm exceeds it, and the answer should not be "stop the
  app".
- **The engine is not on the deployment's network.** It is started by
  `docker run`, so it is not part of the compose project it renders, and it
  therefore cannot reach `postgres` by name. That is correct for isolation and
  wrong for backups, which need `pg_dump` against the database. Either the
  engine attaches itself to the project network after applying, or the backup
  runs as a short-lived container inside the project. Decide before phase 5;
  it is the kind of thing that is cheap now and structural later.

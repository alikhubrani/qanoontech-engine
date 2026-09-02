# QanoonTech Engine — design

**Status: proposed. Nothing here is built yet.** This document is the decision
record and the plan. Where it states a decision, that decision was made
deliberately and the alternative is written down next to it, so that changing
course later is an argument with a known cost rather than a rediscovery.

---

## What this is

The engine is the control plane for a QanoonTech deployment. It is the only
thing a firm's box needs before it has anything else: it installs QanoonTech,
updates it, configures it, turns optional modules on and off, takes and restores
backups, and enforces the licence.

It is not part of the application. It never serves user traffic, never reads a
client document, and never runs SQL against the firm's database. Everything it
does is deployment state — which containers exist, what version they are, what
credentials they hold, whether they are healthy.

**One box, one firm, one engine.** There is no multi-tenancy here. The
multi-firm surface is the licence service, which is a separate component and
runs on our side, not theirs.

### The line, stated once

| | engine | application |
| --- | --- | --- |
| owns | whether a thing is **deployed** | whether a feature is **visible to users** |
| holds | images, versions, credentials, container lifecycle | cases, clients, documents |
| knows about modules | everything: image, cost, config, health | only whether one **answers** |
| storage | its own volume | Postgres + uploads |
| reachable | `127.0.0.1:8081`, never published | through nginx and the tunnel |

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
want for PaddleOCR and the Drive mirror.

What we did **not** take: AIO creates containers over the Docker API directly.
See [Why generated compose](#why-generated-compose-and-not-the-docker-api).

**[Home Assistant Supervisor](https://developers.home-assistant.io/docs/add-ons/)**
— add-ons are containers with a **declared options schema**, and the Supervisor
type-checks, range-checks and format-checks every option before starting one.
Our module catalogue carries the same idea: a module that cannot describe its
own configuration cannot be shipped.

**[Replicated KOTS](https://docs.replicated.com/intro-kots)** — the reference
for what an on-prem admin console is expected to contain: licence verification,
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
  entitlement: 'module.ocr',      // licence key that must be present
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
the sidecar answers, the Drive mirror is on because it is reachable. The engine
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
| `drive-mirror` | offsite document mirror | ~120 MB | extracted from the application's in-process worker; see below |
| `tunnel` | Cloudflare tunnel | ~40 MB | the only inbound path |

### Google Drive — one credential, two consumers

A firm wants one switch: "copy our things to our Google Drive." Behind it are
two genuinely different jobs:

| | document mirror | backup copy |
| --- | --- | --- |
| shape | thousands of small files, continuously | one large file a night |
| needs | a job queue, retries, per-file state | a verified handoff at the end of one operation |
| read back by | the application, per document | the engine, as a whole set, during a restore |

They must not be fused. The decisive reason is that **the backup exists to work
when the application does not** — routing it through anything the application
owns means that a broken app is also a broken backup, and a restore would depend
on asking a container that may well be the reason you are restoring.

The resolution is that the *credential* is unified and the *runtime* is not:

```
              Engine — the only place the key is typed
                  service account key + shared drive id
                            │
              ┌─────────────┴──────────────┐
              ▼                            ▼
      engine's own backup copy      drive-mirror container
      (pg_dump → Drive)             (secret injected at start)
              │                            │
              ▼                            ▼
        firm's Shared Drive          firm's Shared Drive
```

One form, one switch, two paths that share a transport and nothing else. The
engine keeps its copy of the key on its own volume; the mirror gets it injected
as a secret. Neither depends on the other, and neither depends on the
application's database or its encryption key.

The mirror becoming its own container is the larger half of this and is
scheduled accordingly — see [phase 5](#phasing). It fixes something real on the
way: a Drive outage today is a failure inside the application process,
competing for its memory limit and buried in its logs.

---

## Licensing

Three layers, each answering a different question. They are independent on
purpose: no single failure removes all commercial control, and no single failure
takes a firm down.

| layer | question | mechanism |
| --- | --- | --- |
| registry credential | may this firm **obtain** software? | per-firm GHCR token, `read:packages` |
| signed licence | **what** is enabled, and until when? | Ed25519-signed licence, verified offline |
| heartbeat | has this been **revoked**? | periodic call to the licence service |

### The licence

A licence is an Ed25519-signed document — firm id, issue and expiry dates,
entitled module ids, seat limit, licence id. The engine carries the public key
and verifies it locally. No network call is required to *use* a licence, which
means our infrastructure being down never prevents a firm from working.

The format has to be right on the first release: it is the one thing that cannot
be changed retroactively across boxes already deployed. Version the payload from
day one.

Signing keys live in our infrastructure and never in this repository. The public
key is compiled into the engine image.

### The heartbeat, and enforcement

**Decision: heartbeat required; enforcement is hard.** The engine calls the
licence service periodically. Sustained failure, past grace, stops the firm's
system.

This was chosen with the alternative on the table. The argument against is
recorded here because a future reader deserves it: hard enforcement makes our
licence service a hard dependency of a law firm's production system, and the
industry has moved away from it —
[cutting access immediately](https://keyforge.dev/blog/perpetual-fallback) "is
the simplest implementation, but it produces the worst outcome." The mitigations
below exist because that argument is real, and they are not optional garnish.

**Grace: 30 days, with escalating warnings from the first missed check.**

```
day 0    missed heartbeat   →  engine Overview shows it
day 7                       →  banner in the app, administrators only
day 14                      →  banner for every user
day 21                      →  daily modal, countdown
day 30                      →  enforcement
```

Thirty days survives a tunnel outage, a Cloudflare incident, our own server
being down, and a two-week Eid closure. The point of the window is that
enforcement should only ever fire on genuine non-payment, never on an outage.

**What enforcement does:**

```
STOPPED                 STILL RUNNING
  app                     postgres      data intact
  nginx                   engine        licence screen, accepts a new licence
  optional modules        backups       nightly copies continue
                          restore       works
                          export        works
```

The firm cannot use the system. The firm can still get their records out. That
line is deliberate and must not move: withholding a client's own files is a
different act from suspending access to software, and in the Saudi legal market
it is the kind of dispute that ends a vendor. It also costs nothing as
leverage — a firm that cannot work will call.

**Offline override.** We must be able to issue a signed, time-boxed licence over
the phone that clears enforcement without a network call. A firm whose
enforcement fired for a reason that turns out to be ours needs a fix in minutes,
not a support ticket.

### Licence service

A separate component, on our side: issues and signs licences, records firms and
entitlements, answers heartbeats, supports revocation. Designed now because the
licence format depends on it; built later. It is deliberately *not* in this
repository — this one is public, and it is the firm's software.

---

## Bootstrap

One command, then a browser.

```bash
docker run -d --name qanoontech-engine \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v qanoontech_engine:/var/lib/qanoontech-engine \
  -p 127.0.0.1:8081:8080 \
  ghcr.io/alikhubrani/qanoontech-engine:latest
```

The engine image is public and needs no credential to pull, which is what makes
this the first step rather than the second. Everything after it happens at
`http://127.0.0.1:8081/`:

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

1. **Never on the public internet.** Bound to `127.0.0.1` by default; reachable
   through Cloudflare One if the firm chooses, never published.
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

| section | contents |
| --- | --- |
| Overview | health, disk, backup age, version, licence status — the page you leave open |
| Services | per-service state, version, start/stop/restart, logs |
| Modules | the catalogue, off by default, resource cost stated, config form per module |
| Backups | list, create, restore, verification result, offsite status |
| Updates | installed, available, changes, update, rollback, history |
| Configuration | the settings form — storage, language, limits, addresses |
| Licence | status, entitlements, expiry, heartbeat, enter a new licence |
| Diagnostics | re-run preflight, download support bundle |
| Settings | engine password, session length, TOTP, access |

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
| **1** | Catalogue, renderer, container interface, compose generation. CLI only, no UI | a stack can be brought up and down from the catalogue alone |
| **2** | Web UI: Overview, Services, logs, start/stop/restart. Auth, throttle, audit log | an operator runs the deployment from a browser |
| **3** | Licence: format, offline verification, heartbeat client, grace state machine, enforcement, offline override | enforcement fires correctly on a test box and clears with a new licence |
| **4** | Bootstrap wizard, preflight, versions and rollback, self-update, `rescue.sh` | a clean box goes from one `docker run` to a running firm in a browser |
| **5** | Modules: PaddleOCR sidecar, Drive mirror extraction, tunnel. Backups, restore, offsite. Support bundle | modules can be enabled and disabled, and a restore completes without a terminal |

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

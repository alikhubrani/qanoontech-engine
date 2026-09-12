# The engine as a product: recovery, an external database, and a setup worth trusting

**Status: proposed (2026-09-12). Nothing here is built.** Spans two repositories:
most of the work is here, and `qanoontech-app` changes only where a deployment's
database stops being a container this engine starts.

Supersedes the conclusion of
[`point-in-time-recovery.md`](https://github.com/alikhubrani/qanoontech-app/blob/main/docs/spec/point-in-time-recovery.md)
in the application repository — not its measurements, which stand, but its
premise. That document asked "how do we get a better recovery point on this
box". This one asks "what happens when the box is gone", which turns out to be
the question underneath it.

---

## 0. How to work from this document

Three rules, and they are not preamble. Every failure this document exists to
fix was found by doing one of them, and every one of them was skipped at least
once in the week before it was written.

**Inspect before building, every phase.** Read the code the phase touches
*first* and write down what is actually there, not what this document assumes.
This is not diligence theatre — in one week, reading first is what found: a
schedule that had stopped for three days behind a hand-written file; an offsite
copy that had been failing for ten days behind 122 audit lines; a `stat` that
returned zero because Cloudflare gzips a HEAD; a backlog that could never drain
because `pendingOffsite` only ever looked at the newest set. Not one of those
was visible from a plan. Each phase below names what to read before writing.

**Prove it on `.106`, end to end, before `.18` sees it.** Not "the tests pass" —
the actual behaviour, on a real box, against real storage. The bar for each
phase is written as something a person can watch happen. Staging earned its
place twice this week: the NaN bug and the gzipped-HEAD bug were both caught
there and both would have reached a firm otherwise.

**Best practice means measured, not assumed.** The PITR document argued for
pgBackRest with continuous WAL archiving and was correct about the general case
and wrong here, because nobody had measured the database: 13 MB, a 142 KB
compressed dump, 156 ms to take one, against a 16 MB WAL segment. One segment is
larger than the whole database. Where this document states a number, it was
measured on a real box on the date given. Where a phase needs a number, measure
it before choosing.

---

## 1. What this is for

Three goals, in the order they matter:

1. **A machine dies and a new one takes its place, easily.** Install Docker, run
   the engine, give it a bucket and a passphrase, and the firm has its database,
   its documents and its configuration back. Today this is not possible at all —
   see §2.
2. **The database is not married to one place.** On the app's machine, on a VM,
   or managed — a connection string, not an architecture. The engine should not
   care, and moving should not be a rebuild.
3. **The engine should be a product.** It currently reports state without taking
   responsibility for it, which is the honest reason it feels provisional.

---

## 2. What exists now, measured

On the firm's box (`.18`) and staging (`.106`), 2026-09-11 to 2026-09-12:

| | |
|---|---|
| Application database | 13 MB; a compressed dump is 142 KB and takes 156 ms |
| Documents | 11.9 MB across 26 files, growing ~1.3 MB/day |
| Engine's own state | **~8.8 KB** of JSON: `state.json` 959 B, `secrets.json` 520 B, `audit.jsonl` 6.8 KB, the rest under 250 B each |
| Backup sets | hourly database, daily with documents; generational retention |
| Offsite | Cloudflare R2, proven end to end on `.106` (take → upload → delete local → fetch → restore, 49 tables in 1.1 s) |
| Restore time | 1.0–1.1 s for the database, measured by `backup drill` |

### The gap, stated plainly

**The engine's state is on the box that dies.** `secrets.json` holds
`DB_PASSWORD`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `GHCR_TOKEN`,
`SETTINGS_ENCRYPTION_KEY`, `SMTP_PASSWORD`, `SMTP_OAUTH_SECRET`. `state.json`
holds the version, the enabled modules and every module's configuration. None of
it leaves the machine: `uploadSet` copies `backups/<id>/` and nothing else.

So today, with backups safely in R2, a new machine can fetch a database dump and
**not be able to do anything with it** — no password to restore it with, no
compose file to bring up, and no `SETTINGS_ENCRYPTION_KEY`, so even a restored
database has integration settings nobody can decrypt.

That is 8.8 KB standing between an afternoon and a fortnight.

### And documents do not go offsite at all

They ride the daily backup set as a tar of the whole volume. That is 11.9 MB
today and fine; at 10 GB it is 10 GB per set and roughly 900 GB retained, storing
the same unchanged PDF ninety times. It fails by getting slow and expensive,
which is the worst way to fail.

---

## 3. The rule everything else bends around

> **The recovery path never touches the engine's database.**

Moving engine state into Postgres is right for every other reason and introduces
exactly one risk: the engine's job is to work when everything else is broken,
and an external database is one more thing that can be down at the moment it is
needed.

So state lives in Postgres as the source of truth **and** as a continuously
updated encrypted snapshot in object storage. `engine recover` reads the
snapshot. It must be possible to rebuild a deployment knowing only:

- the bucket, its endpoint and two keys
- one recovery passphrase

Nothing else. Not the engine database's URL, not the application database's URL —
both of those are *inside* the snapshot.

A second consequence: once the engine's database may be Neon, RDS or a VM,
secrets are at rest in somewhere the firm does not necessarily own. They are
encrypted before they are written, with a key derived from the operator's
recovery passphrase. This is not the same argument as encrypting `secrets.json`
on a box whose Docker socket already grants root — that was close to theatre.
This is not.

---

## 4. Phases

Each phase names what to read first, what to build, and what has to be watched
working on `.106`. A phase is not done when its tests pass; it is done when its
acceptance line has happened on a real box.

### Phase 1 — Documents go offsite, incrementally

**Read first.** `src/backup/service.ts` (`takeBackup`, `archiveUploads`),
`src/docker/index.ts` (the uploads helper), `src/backup/store.ts`, and in the
application `server/storage/local.provider.ts` and `server/storage/types.ts`.
Establish, do not assume: whether anything deletes bytes from the uploads volume,
and whether a stored file is ever overwritten in place. *As of 2026-09-12,
`storage.delete()` has exactly one caller — the cleanup path when generating a
document fails — and purge leaves bytes on disk. If that is still true, the
volume is append-only and this phase is simple. If it has changed, stop and
re-plan.*

**Build.** Files sync to `documents/<path>` in the bucket, once each, keyed by
path and skipped when already present at the same size. Documents leave the
daily tar. Each backup set carries a `documents.index.json` listing the paths
that existed when it was taken, so a restore knows what to fetch without first
needing a readable database.

**Retention trap, stated so it is not rediscovered.** Documents must outlive
every backup set that references them. A monthly set from March pointing at
files pruned in April is not a backup. The blob store prunes last, and only what
no retained set names.

**Acceptance on `.106`.** Upload a document through the application; watch it
appear in the bucket within a tick. Delete the local uploads volume. Recover it
from the bucket. Open the document in the application.

### Phase 2 — Encrypted engine state offsite, and `engine recover`

**Read first.** `src/state/store.ts`, `src/lib/json-files.ts`,
`src/backup/offsite.ts`, `src/server/routes/deploy.ts`, and the first-run path in
`src/server/auth.ts`. Confirm what the complete set of state files is rather than
trusting §2's list.

**Build.** A snapshot of engine state — settings, secrets, module config, enough
audit to explain the last deploy — encrypted with a key derived from the
recovery passphrase, written to the bucket whenever it changes and on a tick.
Then `engine recover`: endpoint, bucket, two keys, passphrase → state, compose,
newest backup set, documents, up, and a `backup drill` at the end to prove what
it restored.

**Acceptance on `.106`.** Destroy the engine volume entirely. On a clean Docker,
run the engine, give it four values and a passphrase, and watch the deployment
come back. Sign in to the application. Open a case. Open a document.

### Phase 3 — The database is a connection string

**Read first.** `src/catalogue/modules/app.ts` (it assembles `DATABASE_URL` from
settings and the deployed host), `src/catalogue/modules/postgres.ts`
(`required: true`), `src/plan.ts`, `src/docker/index.ts` (`dumpDatabase`,
`restoreDatabase`, `psqlQuery` all assume a host called `postgres` on the compose
network), and `src/preflight/index.ts`.

**Build.** A `databaseUrl` setting. Empty means today's behaviour exactly —
assemble from the deployed `postgres` module, so no existing deployment changes.
Set means use it, and `postgres` stops being required. Backup, restore, drill and
preflight all take the URL rather than assuming a neighbour container.

**Acceptance on `.106`.** Move the application's database to an external
Postgres without reinstalling anything: set the URL, apply, sign in, and watch
`backup drill` pass against it. Then move it back.

### Phase 4 — The engine's own database, and two setups

**Read first.** Everything Phase 2 touched, plus `src/server/audit.ts`,
`src/server/routes/*.ts` and the panel's `ui/src/pages/Login.tsx` and
`Settings.tsx`.

**Build.** Engine state in its own Postgres, secrets encrypted before they are
written. Two setups, which is the shape the product wants:

- **Setup one, the engine.** Operator password → engine database URL → recovery
  passphrase. The engine is alive and knows nothing about any deployment.
- **Setup two, the deployment.** Either *new* — registry credentials,
  application database URL, modules, version, deploy — or *recover*, which is
  Phase 2's flow with a form in front of it.

**Migration matters here.** Existing deployments have their state in JSON on a
volume. First start after this ships must import it, verify it, and only then
stop reading the files. A firm must not have to do anything.

**Acceptance on `.106`.** Set up an engine from nothing against a real external
Postgres. Then take an existing `.106`-shaped deployment with JSON state and
watch it migrate itself on first start, with the audit trail intact.

### Phase 5 — The panel takes responsibility

**Read first.** `ui/src/pages/*` — 6,312 lines across seven pages, which is not
nothing and is the reason the fix here is not "write a UI".

**Build.** An overview that leads with health rather than inventory; a guided
first run; recovery as a first-class flow rather than a command someone has to
know exists. The honest diagnosis, from a single week: backups stopped for three
days, offsite failed for ten, 122 failures were logged and nobody was told, and
the panel was green throughout. It reported state without taking responsibility
for it. That is what "flimsy" is, and no storage engine fixes it.

### Then, and separately — the application's query patterns

**Before anything moves, not after.** `server/services/case.service.ts` alone
makes 47 Prisma calls and uses `include` 23 times. On a local socket that costs
milliseconds. Across a network it costs hundreds of them per page, and the
diagnosis becomes "managed Postgres is slow" when the answer is twenty round
trips where three would do. Measure with the URL configurable (Phase 3) so it can
be measured both ways.

---

## 5. What this does not do

- **It does not choose where the databases live.** That is the point: after
  Phase 3 it is a setting, and it can change without a rebuild.
- **It does not add WAL archiving.** The measurements in the PITR document stand:
  at 13 MB a WAL segment is larger than the database, and the same recovery point
  costs 115× less as snapshots. If the database passes roughly a gigabyte, or if
  it moves to a managed service that offers PITR as a feature, re-open that
  document.
- **It does not retire Google Drive yet.** Drive goes when Phase 1 has run on the
  firm's box and their documents are demonstrably in R2 — not before. The Drive
  *mirror* in the application is a separate thing again: it exists so a human can
  browse the archive, not so it can be restored, and retiring it is its own
  decision.
- **It does not encrypt the backup sets themselves.** Worth doing, and a separate
  decision: it changes what a restore needs to hand and what is lost if a
  passphrase is.

---

## 6. Decisions still open

1. **One database server or two.** Recommended: two URLs, and behind them
   whatever the firm wants — but if the application's database is the thing that
   is broken, the engine should not be broken with it.
2. **Where the engine's database lives first.** Recommended: a VM the firm owns,
   not a managed service, so the engine does not need an internet service to
   start.
3. **Whether the whole system ever moves to the cloud.** It changes nothing in
   phases 1–3 and it changes Phase 5's shape, so it is worth answering before
   Phase 4.

---

## 7. What the engine's database needs

Small, because engine state is 8.8 KB and will not grow much — the audit trail
adds roughly 275 KB a year. Sizing is irrelevant; reachability and durability are
not.

- **PostgreSQL 15 or later.**
- **A database and a role per deployment**, not one shared: `.106` and `.18` get
  separate credentials so one compromised box cannot read or damage the other's
  configuration.
- **Reachable from each engine container**, which means `listen_addresses`,
  `pg_hba.conf` and the firewall all allowing it — from `192.168.1.18` and
  `192.168.1.106`.
- **TLS if it leaves the LAN.** On the same network, `sslmode=prefer` is
  defensible. Across the internet, `sslmode=require` at minimum and an IP
  allowlist, because this database holds the credentials to everything else.
- **Its own backup**, or an explicit decision that it does not need one — the
  encrypted snapshot in the bucket is the real recovery path, so losing this
  database costs a restore, not the deployment.

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
every backup set that references them. A set from last month pointing at files
pruned last week is not a backup. The blob store prunes last, and only what
no retained set names.

**Acceptance on `.106`.** Upload a document through the application; watch it
appear in the bucket within a tick. Delete the local uploads volume. Recover it
from the bucket. Open the document in the application.

**Status 2026-09-12 — running on both boxes.** `.106` holds 80 document objects
(8.3 MB); `.18` holds all 28 of the firm's documents (11.86 MB), which landed on
the first tick after R2 was switched on there. Backup sets drain one per tick,
newest first and then oldest-first through the backlog — watched on `.18` from
27 waiting down through 24 with `alert-sent` staying at 0 the whole time, which
is the state that had staging emailing every five minutes before 0.11.2.

Both boxes have now passed `backup drill`. Still outstanding in this phase:
**bringing a set back from the bucket and restoring *that*** — `offsite test`
proves the bucket takes and returns bytes and `backup drill` proves a *local*
dump restores, but the R2 round trip has never been exercised outside a test.
`fetchSet` and `listRemote` are wired only to the web panel, not to `cli.ts`,
so the recovery path a firm would actually use cannot be driven from a shell —
which contradicts §3's rule that the engine must work when the application does
not. `offsite fetch <id>` belongs in the CLI.

*Both closed 2026-09-12.* `offsite list` and `offsite fetch` shipped in 0.13.0,
and the round trip was proven on `.106`: a set was deleted from disk so the
bucket held the only copy, fetched back, and restored — 35 tables in 0.8s.

**1b is decided against, not deferred.** The plan was to drop `uploads.tar.gz`
from each set once documents were in the bucket separately. It never cost
bandwidth — `uploadSet` has always skipped the tar — so the whole saving was
about 320 MB of local disk on the firm's box. Against that, now that documents
go offsite on their own, **the tar is the offline copy**: it is what lets a set
restore with no network at all, on a box whose internet is down or whose R2
credentials have been rotated out from under it. A backup that needs a working
connection to be a backup is a weaker backup. 320 MB is a fair price, and
`backupIncludeUploads` stays true.

Phase 1 is complete.

### Phase 2 — Encrypted engine state offsite, and `engine recover`

**Read first.** `src/state/store.ts`, `src/lib/json-files.ts`,
`src/backup/offsite.ts`, `src/server/routes/deploy.ts`, and the first-run path in
`src/server/auth.ts`. Confirm what the complete set of state files is rather than
trusting §2's list.

**Inspected 2026-09-12. §2's list was wrong in two ways, and both change the
design.**

`offsite.json` appears in the code's file constants but is **not** root state —
it lives at `backups/<set id>/offsite.json`, one per set. It travels with the
set, so a recovery that fetches sets from the bucket gets it back for free and
must not try to snapshot it globally.

`.106` holds `auth.json.bak-20260907` — a stray file no code writes, left by
hand. **So the snapshot takes a known list, never a directory glob.** A glob
would have carried a stale credential file to the new machine and, depending on
restore order, reinstated a superseded password. Anything not on the list is not
state, however much it looks like it.

What the eleven real files are, and what recovery should do with each:

| file | recover? | why |
| --- | --- | --- |
| `state.json` | **yes** | settings, version, enabled modules — the deployment's identity |
| `secrets.json` | **yes** | the point of the exercise; encrypted at rest in the bucket |
| `licence.paseto` | **yes** | without it a recovered box is unlicensed and stops |
| `auth.json` | **decide** | the operator password hash. Recovering it restores access with a credential that may be why you are recovering. See below. |
| `audit.jsonl` | **tail only** | enough to explain the last deploy; it is append-only history, not state, and the whole file may be large |
| `docker-compose.generated.yml` | **no** | rendered from `state.json` plus the catalogue. Restoring it pins a stale render against a newer engine — the file is an output, and outputs are re-derived, never restored |
| `sessions.json` | **no** | live sessions must not survive onto a different machine |
| `throttle.json` | **no** | a lockout counter is about one box's recent attackers |
| `alerts.json` | **no** | transient; it re-derives on the first tick |
| `clock.json` | **no** | tamper detection for *this* box's clock (`src/licence/clock.ts`) |
| `heartbeat.json` | **no** | a stored conclusion about licence checks, and `src/licence/state.ts` says in its own comment that stored conclusions can disagree with their inputs. Re-derive it. |
| `backups/` | separately | sets come from the bucket by name, carrying their own `offsite.json` |

**The `auth.json` question is real and should be answered before building.**
Recovery is often *because* something went wrong, and restoring the old password
hash restores whatever weakness came with it. The alternative is that a
recovered engine has no credential and runs its ordinary first-run setup, which
is also how a stolen state snapshot stops being a way in. Phase 4a (Entra)
makes this mostly moot, which is an argument for not over-thinking it now:
recover nothing, run setup.

**Build.** A snapshot of engine state — settings, secrets, module config, enough
audit to explain the last deploy — encrypted with a key derived from the
recovery passphrase, written to the bucket whenever it changes and on a tick.
Then `engine recover`: endpoint, bucket, two keys, passphrase → state, compose,
newest backup set, documents, up, and a `backup drill` at the end to prove what
it restored.

**Acceptance — PASSED 2026-09-13 by full teardown on `.106`; AMENDED the same
day, because it had only half passed.**

The table below was true and incomplete. Every count matched, the application
served, and the recovered box **could not accept a new document**: the helper
that writes restored files runs as root, so every directory came back
`root:root 755`, and the application runs as uid 1001. Reads succeed on 644,
which is exactly why eighty documents listed cleanly and nothing looked wrong.
Writes into a directory root owns fail. The acceptance had checked the count of
documents and never tried to add one — a record trusted over the thing it
describes, and this time the record was this table.

Found by accident, while measuring request latency: a probe against
`/api/documents` returned 503s that turned out to be nginx's rate limiter, and
the diagnosis of *that* happened to list the volume's ownership. Fixed by
deriving the application's uid:gid from its image and handing ownership over
after every restore, on both the archive path and the index path. Repaired
live on `.106` with the same `chown`, and writes succeeded at every level.

**Added to the criteria: after recovery, upload a document through the
application and open it.** A count is not a capability.


The whole deployment was destroyed: six containers removed, all five volumes
deleted (engine state, database, uploads, logs, fonts), and every image pulled
for it removed so the registry pull was tested too. The box was left with a
Docker daemon and nothing else.

It came back from an endpoint, a bucket, two keys and a passphrase. Nothing was
copied from the old box. Measured against the fingerprint taken before:

| | before | after |
| --- | --- | --- |
| app version | 1.15.0 | 1.15.0 |
| timezone | Asia/Riyadh | Asia/Riyadh |
| Entra redirect | `localhost:8081/...` | identical |
| secrets | 13 names | 13, same names |
| documents | 80 | 80 |
| users / cases / clients | 10 / 12 / 2 | 10 / 12 / 2 |
| application | serving | `GET / → 307` |

**The teardown found a bug a volume wipe would not have.** Step 4 failed the
first time with `error from registry: unauthorized`: `recovery run` called
`docker.apply()` without signing the daemon in, and compose's registry checks
use the daemon's *stored* login. `jobs.ts` already carried that lesson in a
comment from the first time it was found. It can only appear on a box whose
images are gone — which is the box recovery runs on. Deleting the images rather
than only the state volume is what surfaced it.

**It also proved the compose file is genuinely re-rendered.** The old box was
still running a `drive-mirror` container from a stale compose file. The
recovered box rendered `postgres, app, nginx, gotenberg` — the mirror is gone
from the catalogue, so it is gone from the deployment. A restored compose file
would have tried to start a container whose image no longer exists.

*A fresh VM was the original acceptance criterion and was judged unnecessary
after this run. What it would additionally have tested — preflight on a virgin
kernel, egress from an address that has never reached Cloudflare — is not
nothing, and is recorded here as the gap that remains rather than pretended
away.*

**Original criterion, kept for what it says:**

Destroying the engine volume on `.106` is the *rehearsal*, not the test. It
leaves the image cache warm, the host configured, the network already working
and the box already trusted by R2 — so it proves the state snapshot is readable
and proves nothing about the parts of recovery that only fail on a cold
machine: a registry pull with no cache, preflight against a virgin kernel,
egress to Cloudflare from an address that has never reached it, and a clock that
nobody has set. Recovery is exactly the situation where none of those can be
assumed, because the machine you are recovering onto is the one you bought this
morning.

So the test is **a fresh VM**, and it passes only when every line below is true:

1. A new VM, no QanoonTech image ever pulled, no state volume.
2. Install the engine. Give it the endpoint, the bucket, two keys and the
   recovery passphrase — and nothing else. No file copied by hand, no value
   read off the old box, no `docker cp`.
3. It comes back: state, compose, the newest backup set, the documents.
4. Sign in to the application. Open a case. Open a document and read it.
5. `backup drill` on the recovered box passes.
6. Row counts match the source: same tables, users, cases, clients.

Do the volume-destroy rehearsal on `.106` first, because a failure there is
cheap to diagnose. But the phase is not done until the VM run passes, and the
VM run is what gets recorded.

**Why this is the acceptance test and not a nice-to-have.** Everything this
programme has caught has been of one kind — a record asserting a safety
property, trusted over the thing it describes. The manifest that stopped the
schedule for three days. The health check green while backups were dead. A size
read from a header that was not there. An alert announcing its own recovery
forever. `offsite.json` claiming copies that had been deleted. And, found on
2026-09-12 and still open, an audit line reading *"taken and verified"* over
code that checks pg_dump's exit status and nothing else.

A recovery procedure nobody has run end to end on a cold machine is the same
kind of record: a claim about a safety property, believed because it was
written down. The only thing that converts it is running it.

**What was measured on 2026-09-12**, so the VM run has numbers to beat:

| | `.106` | `.18` (the firm) |
| --- | --- | --- |
| database restore | 1.1s | 1.0s |
| tables | 49 | 49 |
| rows | 10 users, 12 cases, 2 clients | 4 users, 6 cases, 6 clients |
| documents in the bucket | 80 objects, 8.3 MB | 28 objects, 11.86 MB |

Both drills restored into a scratch database and dropped it; neither live
database was touched, and no scratch database was left behind. This was the
first time any set on the firm's box had been proven restorable — 27 sets going
back to 3 September had been described as "verified" by an audit line that
verified nothing.

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

**This is the phase where rollback stops being free.** Every other phase undoes
by swapping an image: Phase 2 is additive, Phase 4a ships
`engine auth use-password` for exactly this reason. Not this one. Once a firm's
data is on an external PostgreSQL 17 server, going back to in-compose 15 is a
restore, not a rollback — the same shape as the app's R4 migration, the one
change in that programme that could not be undone by changing the image. Plan
the window accordingly, take a set immediately before, and drill it before
starting rather than after.

**Postgres 15 → 17 rides along here, and only here.** Decided 2026-09-12.

Both boxes run PostgreSQL 15.19 in compose, and `postgres` is pinned to a major
version in the catalogue with `required: true` — deliberately, because a major
version is a data-directory format, not a tag. PG 17 refuses to start on a PG 15
datadir, so an engine update that could move the pin would leave a firm with a
database that does not boot.

The upgrade is therefore a dump-and-restore, and **that is exactly what this
phase already is.** Moving the database to an external server means dumping from
the old one and restoring into the new one; provision the new one at 17 and the
version upgrade costs nothing extra. Doing it before this phase means paying the
same disruption twice on a live box — once to go 15→17 inside compose, once to
go compose→external — and building an in-compose major-upgrade path that this
phase then deletes.

Nothing is forcing the clock: PG 15 is supported to November 2027.

The mechanics are small at this scale. `.18`'s entire database is a 0.1 MB
compressed dump and the drill on 2026-09-12 restored it in 1.0 seconds, so the
migration window is seconds of downtime, not an evening. What makes it worth
doing carefully is not the size but that it is the one operation where a bad
backup is discovered too late — which is why `verifyDump` landed first.

**Acceptance on `.106`.** Move the application's database to an external
Postgres **17** without reinstalling anything: set the URL, apply, sign in, and
watch `backup drill` pass against it. Row counts must match the source. Then
move it back to prove the path is not one-way.

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

### Phase 4a — Operator sign-in moves to Entra

Specified separately in [`operator-sign-in.md`](./operator-sign-in.md); slotted
here because it wants Phase 4's settings work already done and because it
constrains Phase 5 rather than following it.

One password with no MFA, no revocation and no attribution guards a panel that
can deploy, restore over a live database, and read every secret in the estate.
Entra against a single tenant fixes all four.

**It is safe only because the CLI authenticates zero times** — `docker exec` is
the authentication, so the shell stays reachable when Microsoft is not. Which
makes one rule binding on the phase below: **no operation may be panel-only.**
Read Phase 5 with that in hand.

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
- **~~It does not retire Google Drive yet.~~** *Retired 2026-09-12, ahead of the
  gate this bullet set — and the gate is worth recording rather than quietly
  stepping over.* It said Drive goes only once the firm's documents are
  demonstrably in R2, on the reasoning that removing a destination a box is
  using would leave it with none. That reasoning did not apply: `.18` had
  `backupOffsiteProvider: 'drive'` with `backupOffsiteEnabled: false` and had
  never sent a byte anywhere, and `.106` had already moved to R2. There was no
  Drive copy to lose on either box, so the gate was protecting nothing.

  What the gate *was* right about is still true and still outstanding: **`.18`
  has no offsite copy at all.** Retiring Drive did not cause that and does not
  worsen it, but it does not fix it either — Phase 1 step 3 does, and it remains
  the most important thing on this list.

  The Drive *mirror* in the application went with it. It existed so a human
  could browse the archive, not so anything could be restored, and the engine
  now copies documents to the bucket under `documents/` — one destination, one
  credential, one thing to check.
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

### ~~Open defect~~ — fixed 2026-09-12: `"taken and verified"` now verifies

Found 2026-09-12, unfixed. `takeBackup` writes this audit line after every set:

```
{"event":"backup-taken","detail":"Backup 2026-09-12T16-23-44Z taken and verified."}
```

The whole of the verification behind that word is:

```ts
const dump = await docker.dumpDatabase(target, containerPath(id, 'database.sql.gz'))
if (dump.code !== 0) { ...fail... }
```

pg_dump's exit status. Nothing reads the dump back, nothing checks the gzip is
intact, nothing counts a row. The line is on the firm's box 27 times covering
sets back to 3 September, and until the drill on 2026-09-12 not one of them had
ever been restored.

It was the programme's recurring failure in its purest form: a record asserting
a safety property, written by the thing that benefits from it being believed.

**Fixed by `verifyDump` in `src/backup/service.ts`.** Every set is now read back
before it is called one: the dump is stream-decompressed, which makes gzip's CRC
and length do the work of catching a truncated or corrupt file, and the tail is
checked for pg_dump's `-- PostgreSQL database dump complete`, which catches the
worse case — well-formed gzip that simply stops early, restoring into a database
quietly missing its last tables. A set that fails either check is deleted rather
than kept, because half a dump on disk is what the retention shape counts and
what the health check calls recent.

The test fixture turned out to be the same bug in miniature. The mock wrote
`'dump'.repeat(100)` as plain text — never gzip, no structure, no end — and it
passed for as long as the only check was an exit status. It is now a real
gzipped dump with the `\restrict` wrapper copied off a live 15.19 box, and the
four ways a dump can be wrong each have a test: truncated gzip, not gzip,
valid gzip that stops early, and empty.

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

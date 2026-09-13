# The panel

**Status: 0.20, 0.21 and 0.22 shipped 2026-09-13; the panel now covers the parity table in section 5 — Phase 6 of `engine-as-a-product.md`.** This
is the standing description of what the panel is for and how it is put
together. It was written after reviewing every page of engine 0.19.3 in a
browser at 1440 px, with the source open beside each screenshot; the review's
findings are in section 2 so that the reasons survive the rebuild.

## 1. What it is for

One person operates one firm's deployment, from a browser through a Cloudflare
tunnel, with the CLI as the peer that works when the browser cannot. The
panel's job, in one sentence:

> **Show whether the firm is safe right now, and let every change to the
> deployment be made without a shell — completely, and no less safely than
> the CLI makes it.**

Three responsibilities fall out of that, and every page belongs to exactly
one:

| Responsibility | Question it answers | Pages |
|---|---|---|
| **Assurance** | Is the firm's data safe, and if not, what is wrong? | Overview, Services, Activity |
| **Change** | What version, modules and settings run, and how do I change them safely? | Deploy |
| **Recovery** | What copies exist, where, and can I get back from them? | Backups, Settings › Recovery |

Two rules bind the whole design:

1. **No operation may be panel-only** (from Phase 4a). `docker exec` is the
   authentication of last resort, so the CLI must be able to do everything the
   panel can. The inverse is *not* a rule — an operation may be CLI-only when
   there is a reason — but each such case is named in the parity table in
   section 5, with its reason, and "nobody built it" is not a reason.
2. **A record is never trusted over the thing it describes.** The overview's
   verdict is computed from what is on disk and in Docker at request time, by
   the same function `engine status` uses. It is not a stored conclusion and
   it is not the absence of failures in a log. This is the lesson of the
   three-day silence and the two-hour loop gap, applied to the one screen the
   operator leaves open.

## 2. What the review found

Engine 0.19.3, staging, 2026-09-13. Each finding is a fact about a page, then
what it means.

### The overview reports inventory, not safety

Three tiles (application version, engine version, bind address), a card
saying "All services healthy", and a table of recent audit lines. Nothing on
the page says whether a backup exists, whether it reached offsite storage,
whether the engine's own state is recoverable, or whether sign-in is locked
to a hostname. Those are the four things the last three phases built, and the
panel does not know they exist. "All services healthy" is the sentence the
programme document quotes as the failure: green throughout, three days of no
backups.

### The activity feed is 81 % noise, and the noise is a defect

Of 166 audit lines on the staging box in the last 24 hours, 135 are
`snapshot-copied`, twelve an hour. The cause is a feedback loop in
`backup/snapshot.ts`: the snapshot body includes the last 200 audit lines and
is hashed to decide whether anything changed; the tick then records
`snapshot-copied` in the audit; so the next tick's body differs and it copies
again. 288 uploads a day of a 28 KB object where ~25 would do, and the panel
displayed it for a day without anyone noticing — because a table of raw event
slugs is not a thing anyone reads. The fix is in the engine (section 4), and
the panel's feed is then rebuilt to show *notable* events, with routine ones
a click away.

### Services can make a false statement

On a box whose database is external — the whole of Phase 3 — the Database row
reads **"not created · required"**, which is what a fresh box with no database
looks like. The row is derived from `docker compose ps`, which no longer knows
about the database, and the page has no other source. The Actions column is
also clipped at 1440 px (a horizontal scrollbar inside the table), and the
image column truncates to `ghcr.io/alikhubrani/qanoont…`, the one part that
does not vary.

### Backups describes a system that no longer exists

The page says backups are "taken nightly", that "the offsite copy is the next
piece of work", labels hourly sets **nightly**, badges them **in Drive**, and
offers a "Shared Drive ID" field whose value the engine has dropped from its
schema since 0.13.0 — saving it posts `backupOffsiteDriveId`, which zod
discards. Google Drive was retired on 2026-09-12; the strings and the
`driveId` type were not. There is no health strip, no schedule or retention
control (four settings exist in state with no UI), no drill, no documents-sync
state, no recovery-snapshot state, and a red Delete on every row of the one
table that is the firm's way back.

### Deploy is six stacked cards with no notion of drift

Registry credential (blank inputs shown even when configured), deployment
settings (which are application configuration, not a deploy step), modules
(configure panels expand inline and push the rest of the page down), version
(configured and previous, but never *running* — so a version set and not yet
deployed is invisible), preflight (manual), deploy. The email module's
configure panel offers a **Database URL** field whose own help text says
"configure it with `database use`, not here" — a control that tells you not
to use it. `logLevel` and `maxFileSizeBytes` are settable and have no field.

### Settings is one card

Engine self-update. Everything else the operator might need to change —
who may sign in, the redirect URI, the offsite bucket and keys, the recovery
passphrase, where the database is, the alert address, the registry
credential — is CLI-only with a comment explaining that configuring the lock
from behind the door is dangerous. The danger is real and is handled by a
guard, not by absence (section 3, Settings › Sign-in).

### The shell

- No routes: the page is React state, so a reload lands on Overview, the
  back button does nothing, and no page can be linked.
- The palette is the application's *previous* one — QanoonTech blue on slate,
  Inter — with a comment saying it maps the app's tokens. The application
  moved to the Harvey-derived ivory-to-ink system on 2026-09-06
  (`docs/design-system.md` in the app repository). The panel is the one
  surface of the product that does not look like the product.
- Header carries a centred one-item breadcrumb and a user menu whose only
  entry is "Operator"; the sign-in page is the one screen with any
  typographic intent.
- Dark-mode variables are half-defined; toasts, dialogs and sheets are stock.

### What the CLI can do that the panel cannot

Of 40 CLI commands, 19 have a panel path. Missing: `backup drill`,
`offsite status/use-s3/test`, `database status/use/use-local`, `recovery
passphrase/status/show`, `auth status/redirect/allow/sign-out-everyone`,
`secrets list/set/remove` for anything not attached to a module (the S3 key
pair, the recovery passphrase, the Entra client secret, the database URL), and
the schedule and retention settings. The table in section 5 is the target.

## 3. The design

### Information architecture

Six pages, real URLs, tabs where a page has more than one kind of thing on it.

```
/                     Overview      verdict · facts row · needs attention · notable activity
/services             Services      table · logs sheet
/activity             Activity      the whole audit trail, filterable, paged
/deploy/release       Deploy        running vs configured · choose · check · deploy · roll back
/deploy/modules                     modules, each configured in a sheet
/deploy/configuration               bind · port · timezone · language · log level · upload limit
/backups/sets         Backups       health strip · sets table · restore · copy offsite · delete
/backups/offsite                    bucket · credentials · test · what the bucket holds · bring back
/backups/schedule                   interval · daily hour · retention · local documents
/backups/recovery                   passphrase · last snapshot · drill · what recovery needs
/settings/sign-in     Settings      tenant · application · allowed accounts · redirect · sign out everyone
/settings/database                  local or external · test a URL · switch · back to local
/settings/registry                  the pull credential
/settings/credentials               every secret by name: set or not, used by, replace, remove
/settings/alerts                    the alert address, and the last alert sent
/settings/engine                    version · update · support bundle
```

The sidebar groups are the three responsibilities: **Assurance** (Overview,
Services, Activity), **Change** (Deploy), **Recovery** (Backups), and
Settings on its own at the bottom.

### Overview

The page opens with a **verdict**, one of three, computed by
`assessDeployment()` (section 4):

- **Protected** — every required service is running and healthy; the newest
  backup is within its interval; offsite is on, reachable and has nothing
  older than a day waiting; the engine snapshot is enabled and its last copy
  is current; sign-in is pinned to a hostname.
- **Needs attention** — anything at `warn`: a late backup, a backlog, a module
  that is enabled and unhealthy, a version configured but not deployed, offsite
  off, no recovery passphrase, redirect URI unset.
- **At risk** — anything at `stale`/`none`: backups stopped, nothing offsite
  for a day, a required service down, Docker unreachable, the plan not
  deployable.

Under it, a facts row — one fact per thing the operator is responsible for,
each an age or a value rather than a colour: **Application** (running version, and
"1.16.4 configured, not deployed" when they differ), **Backups** (newest set,
next due, sets kept), **Offsite copy** (bucket, newest set there, documents
synced), **Recovery** (last engine snapshot, passphrase set). Each links to
its page. Then **Needs attention**, present only when non-empty, listing each
finding with the link that fixes it — this is the guided first run Phase 5
asked for: on a fresh box it reads "No registry credential", "Offsite copy is
off", "No recovery passphrase", "Sign-in is not pinned to a hostname", in the
order to do them. Then **Recent activity**, the last eight *notable* events,
with "All activity" to the Activity page.

### Activity

The audit trail is complete and stays complete; the classification is the
panel's, applied server-side, once. Every event carries a `kind`:

| kind | examples | shown on Overview |
|---|---|---|
| `security` | login, login-failed, logout, sign-out-everyone, auth changes | yes |
| `change` | deploy, rollback, module enabled/configured, settings, restore, engine update, an offsite copy working again | yes |
| `failure` | backup-failed, offsite-failed, documents-sync-failed, snapshot-failed, restore-failed, backup-stale, alert-sent | yes |
| `routine` | backup-taken, offsite-uploaded, documents-synced, offsite-fetched, snapshot-copied | no |

An offsite copy that could not reach the store is not a failure until it has
lasted. Since 0.26 the S3 client gives every request a deadline, retries once
after twenty seconds when nothing answered or the store said 5xx, and names
the cause (`ENOTFOUND host`, `ECONNRESET`, "no answer within the time
allowed") instead of Node's bare "fetch failed". The tick then counts failed
ticks per copy — sets, documents, engine snapshot — and writes `*-failed`
only on the third in a row (a quarter of an hour), with when the run began
and the last reason, and `*-recovered` when a reported run ends. A firm's box
wrote eight failure rows in one day under the old rule, every one healed by
the next tick; under this one it would have written none.

The Activity page shows all kinds, filterable, newest first, paged by
timestamp. Labels come from the same catalogue as the kinds, so no raw slug
reaches a screen.

### Services

The table fits: name and description in one column, state as a pill with a
dot, the image tag alone (the registry path is the same for every row and is
shown on hover), and a compact actions cell — Logs as a button, start/stop/
restart in a row menu, with Stop on `app` or `nginx` behind a confirm that
says the firm loses access. The **Database** row reads from the database
target, not from Docker: local, it is the postgres container as now;
external, it reads "External · 192.168.1.108:5435 · PostgreSQL 17.11 ·
reachable", with the reachability probed at request time (one connection, a
`SELECT version()`, cached for the ten-second poll). The logs sheet gains
wrap on/off, a line-count choice (100/300/1000), copy, and a follow toggle
that re-fetches every three seconds.

### Deploy

**Release** is a single column that reads top to bottom as the operation:
running version → configured version (a select, with "same as running" when
they match) → **Check** (preflight, results listed, auto-run when the
configured version changes) → **Deploy**, behind a dialog stating from/to,
that a `pre-update` set is taken first, and that rollback exists → the live
log and image progress while it runs → **Roll back** at the foot, present
when there is a previous version, with the expand-only warning. **Modules**
lists the optional modules as rows; Configure opens a sheet holding the
secrets, the schema form and the resource limits, so the page never reflows.
The database URL is not a module secret and leaves both forms; it lives under
Settings › Database. **Configuration** is the deployment's own settings:
bind address, port, timezone, default language, log level, upload limit, each
with its hint, saved as one form, with the note that they take effect on the
next deploy.

### Backups

A **health strip** at the top of every tab: the `BackupHealth` line, newest
set age, next due, offsite pending. **Sets**: the table with kinds named for
what they are — hourly, daily (with documents), manual, before update,
before restore — contents, version, offsite state as a pill, and a row menu
holding Restore, Copy offsite now, Delete; Restore's dialog states the
safety copy and the outage; Delete's states that the offsite copy, if any, is
untouched. **Offsite**: the bucket (endpoint, name, label), whether keys are
set, **Test** (the CLI's `offsite test`: a put, a get, a delete), the newest
set and the documents count in the bucket, and the remote list with Bring
back. Configuring it is the CLI's `offsite use-s3` — endpoint and bucket as
settings, the key pair as secrets, in one form. **Schedule**: interval, the
daily hour in the deployment's timezone, retention in days, and whether local
sets carry documents, with what each costs stated beside it (the numbers from
`state/store.ts`). **Recovery**: passphrase set or not (set it here; the
warning that losing it loses the snapshot, and that the sets themselves are
not encrypted), last snapshot copied at, **Run a drill** — restores the
newest set into a scratch database and reports the time and the table counts
— and the four things `recovery run` needs, so that the operator has read
them before the day they matter.

### Settings

**Sign-in**: tenant and application (read-only, they ship), the allowed
accounts by object id with a display name if the sign-in recorded one, the
redirect URI, and Sign out everyone. Editing the allow-list is permitted with
one guard: the request must come from a session whose subject is on the list
being saved, so the operator cannot remove themself; the redirect URI must be
an `https` URL (or `http://localhost`), and saving it states that Entra must
list the same value. The CLI remains the way back in if the guard is wrong.
**Database**: where it is (local container / external host, version, table
count), a URL field to **Test** (the same probe `database use` runs: connect,
version, table count, and the sslmode-against-ssl-off refusal) and then
**Use**, which stores the URL and says a deploy is needed; **Use the local
database** reverses it. **Registry**: the credential, showing "downloads as
*name*" with a change form beneath. **Credentials**: every secret name the
catalogue and the engine know, set or not, which module or feature uses it,
replace, remove (guarded the way `secrets remove` is). **Alerts**: the
address, the last alert sent. **Engine**: version and update as now, plus the
support bundle.

### Look

**Not cards.** The 0.19.3 panel is six stacked shadcn cards per page with the
components as generated, which is the look that reads as machine-made and is
the one thing the product owner ruled out on sight. The direction below was
set after walking real consoles in a browser on 2026-09-13 — Resend (its
emails, domains, logs and settings pages, and a domain's detail page), GitHub's
repository settings, Cloudflare's R2 overview, Linear — and reading what they
have in common: structure comes from typography, hairlines and whitespace;
a page is a title, a line of tabs, then content; a table is rows on rules; a
"thing" page opens with a row of facts under its name; settings are headed
sections over a rule with one Save at the foot; the only boxes are dialogs
and the odd side panel. None of them stacks cards.

Carried into the product's own system (`docs/design-system.md` in the
application repository, the Harvey-derived ivory-to-ink scale), which the
panel adopts so the product is one product:

- **Page.** Title in the serif at 26 px with a one-line description beneath
  and the page's action at the end of the line (Cloudflare, Resend). Line
  tabs under it where the page holds more than one kind of thing. Content
  runs to a 72 rem measure; nothing is centred.
- **Sections.** A heading in the sans at weight 500 over a hairline, then the
  content; sections separated by space, not by boxes (GitHub settings). A
  form is stacked label / field / help, two columns where fields are short,
  one Save per section.
- **Facts.** The overview's four responsibilities and any detail header are a
  *facts row*: an eyebrow label (11 px, uppercase, tracked — the engine is
  English-only, so tracking is allowed here where the application forbids
  it), a value in the serif or the sans, a caption; the facts separated by
  hairlines, not framed (Resend's domain page). The verdict is a sentence in
  the serif with a tone dot, not a banner.
- **Lists and tables.** 44 px rows on hairlines; header row 12 px muted; the
  row's menu is a `···` at the end; a state is a pill with a leading dot.
  Activity is a list with the time in a muted right column. No zebra
  striping, no card around the table — the page ground is the table's ground.
- **Colour.** Ivory ground, white only for popovers and the log surface's
  opposite; ink text; the sidebar is the one dark plate; state colour only
  for state through one `tone()` in `ui/src/lib/tones.ts`; no brand hue.
- **Type.** Geist for the interface, Newsreader for titles, verdicts and the
  overview's figures, both self-hosted via `@fontsource-variable` so a firm's
  box never fetches a font. 13–14 px UI, 12 px captions and pills.
- **Shape.** 8 px on dialogs and the log surface, 6 px on controls, 4 px on
  pills. Hairlines, never shadows, except a soft one under a popover.
- **Logs.** Monospace 12 px on an ink surface with a toolbar: wrap, line
  count, copy, follow.
- **Motion.** 150 ms fades on popovers and sheets; nothing else moves.
- **Components.** shadcn primitives kept for behaviour (Radix menus, dialogs,
  sheets, tabs) and re-skinned to the above; a component used as generated is
  a defect. `PageHeader`, `Tabs` (line), `Section`, `FactsRow`, `Pill`,
  `Verdict`, `RowMenu`, `Confirm` (one dialog, a `danger` variant), `Logs`.
  Skeletons for the ten-second poll's first load; nothing spins full-screen.
- **Both themes.** Light is the design; dark is the same tokens re-read from
  the other end, defined in full.

## 4. Engine work the panel needs

Each item mirrors something the CLI already does or fixes a defect the review
found. None is UI.

1. **Snapshot loop.** `snapshot-copied` stops being an audit event; the
   marker file already records `uploadedAt` and `recovery status` reads it.
   `snapshot-failed` is recorded on the way in, like `backup-stale`. The
   hash keeps the audit tail. Expected: about 25 copies a day instead of 288.
2. **Audit catalogue.** `server/audit.ts` gains, for every `AuditEvent`, a
   label and a `kind`; `recent()` takes `{limit, before, kinds}`; entries
   carry `label` and `kind`. The UI's `auditEventLabels` map goes.
3. **`assessDeployment()`** in `src/health/deployment.ts`: services, backup
   health, offsite, snapshot, sign-in, plan, version drift → `{verdict,
   findings[], cards}`. Used by `/api/overview` and by `engine status`, so the
   two never disagree. Pure over its inputs, tested like `assessBackups`.
4. **Running version**: the app container's image tag, on the overview.
5. **Database row**: `listServices()` takes the database target and probes an
   external one.
6. **Routes** (all thin over existing modules): `GET /api/audit`,
   `GET/PUT /api/offsite`, `POST /api/offsite/test`, `GET /api/recovery`,
   `PUT /api/recovery/passphrase`, `POST /api/backups/drill`,
   `GET /api/database`, `POST /api/database/test`, `PUT /api/database`,
   `DELETE /api/database`, `GET/PUT /api/auth`, `POST /api/auth/sign-out-
   everyone`, `GET /api/secrets`, `PUT/DELETE /api/secrets/:name`; the
   settings patch accepts `backupHour`, `backupRetentionDays`,
   `backupIncludeUploads`, `maxFileSizeBytes`.
7. **Session subject.** The Entra callback stores the `oid` (and name, if the
   token carries one) on the session, so the allow-list guard and the audit's
   `subject` have something to say.
8. **SPA routes.** The not-found handler already serves `index.html`; the
   client gets a router.

## 5. Parity

| CLI | Panel | |
|---|---|---|
| `status` | Overview | same `assessDeployment()` |
| `modules`, `enable`, `disable`, `config` | Deploy › Modules | |
| `version`, `versions`, `preflight`, `apply`, `rollback` | Deploy › Release | |
| `secrets init` | — | CLI-only: bootstrap, before a panel exists |
| `secrets set/remove/list` | Settings › Credentials | shipped 0.22 |
| `backup list/now/restore` | Backups › Sets | |
| `backup drill` | Backups › Recovery | |
| `offsite status/use-s3/test/list/fetch` | Backups › Offsite | |
| `database status/use/use-local` | Settings › Database | |
| `recovery passphrase/status` | Backups › Recovery | |
| `recovery run`, `recovery show` | — | CLI-only: runs on a box with no panel yet; `show` prints secrets |
| `auth status/redirect/allow/sign-out-everyone` | Settings › Sign-in | |
| `self-update`, `support-bundle` | Settings › Engine | `support-bundle` added 0.24: the bundle was panel-only |
| `status` (public url line) | Settings › Engine › Address | 0.25: the firm's address, injected as `APP_PUBLIC_URL` for the links in the application's messages |
| `start/stop/restart/logs/ps` | Services | |
| `render`, `serve` | — | CLI-only: developer tools |

## 6. Delivery

Three releases, each shipped to staging, walked in a browser at 1440 px and
1024 px, then to the firm's box.

- **0.20 — Foundations.** Engine items 1–5 and 8; the design system, shell,
  router; Overview, Activity and Services rebuilt; every stale Drive string
  gone. Acceptance: the overview verdict on staging flips to *At risk* when
  the offsite key is made wrong and back when it is restored; the
  `snapshot-copied` rate on `.106` drops from ~135/day to the number of real
  state changes; no page scrolls horizontally at either width.
- **0.21 — Recovery.** Backups rebuilt with its four tabs and their routes.
  Acceptance: a drill run from the panel on `.18` reports the same numbers as
  `backup drill`; the schedule saved from the panel is what `engine status`
  prints.
- **0.22 — Change and Settings.** Deploy rebuilt with its three tabs;
  Settings with its six; the database URL leaves the module forms.
  Acceptance: a deploy of a patch release on staging run entirely from the
  panel, with the pre-update set visible in Backups before the log finishes;
  the allow-list guard refuses removing the signed-in account, with the CLI
  shown to still work.

After 0.22 the parity table has no row that says "nobody built it", and
Phase 5's sentence — "the panel takes responsibility" — is something the
overview can be asked to prove.

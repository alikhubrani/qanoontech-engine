# The licence system, as built — recorded before removal

**Status: archived 2026-09-12. Describes code that was removed, kept so it can
be brought back.** Read as history, never as a description of the current
engine. The signing service (`qanoontech-licence`, a separate repository) is
**not** removed and still holds the key pair this describes.

The last commit containing the implementation is the parent of the one that
removed it; `git log -- src/licence/` finds the whole history.

---

## Why it was removed

It enforced nothing. `src/licence/switch.ts` had held `LICENCE_ENFORCED = false`
for some time: signing, verification, heartbeats, grace and status all ran, and
the one thing that acted on the verdict did not. What remained was 879 lines of
source plus touches in nineteen other files, all to compute a conclusion nothing
used — and a per-deployment ceremony (issue a token, install it, watch it
expire) for a product that is single-tenant and installed by the person who
wrote it.

The judgement is commercial, not technical: the design below is sound and the
reason it went is that it was solving a problem this product does not have yet.
If QanoonTech is ever sold to firms the author does not operate for, this comes
back — which is why it is written down rather than left to `git log`.

## What it did

### The token — `src/licence/format.ts`

**PASETO v4.public, deliberately not JWT.** Both sign with Ed25519, but a JWT
carries a field naming its own algorithm and that field is the source of its two
classic forgeries (`alg: none`, and RS256-verified-as-HS256). A PASETO token
cannot ask to be verified differently: the version *is* the algorithm.

The payload was versioned from day one, because the token format is the one
thing that cannot be changed retroactively across boxes already deployed.
Fields: licence id, firm id, firm name, issued/expires, entitlements, seats, and
a heartbeat descriptor (url, interval hours, grace days).

### The trust root — `src/licence/index.ts`

One embedded public key. The indirection that lets tests inject another exists
for tests and **never reads an environment variable**, deliberately: a trust
root the environment can swap is a licence check that anyone who can write the
compose file can disable.

### What was stored, and what was not — `src/licence/state.ts`

Two files only: `licence.paseto` (the token as handed over) and
`heartbeat.json` (the last signed response). Everything else — grace used,
warning tier, whether to enforce — was **computed** from those plus the clock.
The comment in that file is worth preserving verbatim as a design rule:

> Stored conclusions are conclusions that can disagree with their inputs.

### Revocation — `src/licence/heartbeat.ts`

The box asked the service whether the licence was still good. The request
carried nothing sensitive; the **response** was a PASETO signed by the same key
as the licence, because an unsigned "ok" is an "ok" that anyone on the path can
manufacture, and with it revocation is theatre.

An unreachable service, a bad signature and a stale response all failed
identically: no heartbeat, and grace keeps running. **Failing toward enforcement
was the design** — the attacker's easy move, blocking the URL, buys only the
grace window.

### The clock — `src/licence/clock.ts`

Grace measured against the system clock is grace an operator extends forever by
winding the clock back. The defence was a high-water mark: every observation
recorded the latest time the engine had ever seen, and a system clock behind
that mark lost to it. Time that has been seen has elapsed, whatever the clock
now claims. A *forward* jump was left alone — it only shortens grace, and
correcting a slow clock is routine.

### What enforcement stopped — `src/licence/enforce.ts`

```
STOPPED                    STILL RUNNING
  app                        postgres    the firm's data, intact
  nginx                      the engine  this panel, and a new-licence form
  optional modules           backups     nightly copies continue
```

**The firm cannot use the system; the firm can still get their records out.**
That line was deliberate and did not move. Suspending access to software is a
commercial act; withholding a firm's own files is a different thing entirely,
and backups continued running throughout so a lapse could never become data
loss.

### Entitlements — `src/catalogue/index.ts`

Each optional module declared an `entitlement` string (`module.email`,
`module.tunnel`, `module.ocr`). `resolve()` refused a module whose entitlement
the licence did not carry, with `code: 'missing-entitlement'`. Required modules
carried none — **a licensed deployment is entitled to the system itself; the
licence gated what was *added* to it.** That distinction had its own test, so
that an expired licence could never become an inability to render at all.

### Where it was wired

`server/licence-tick.ts` (the periodic check), `server/routes/licence.ts`
(`GET /api/licence`), `cli.ts` (`licence status`, `licence install`),
`preflight/index.ts` (a warning, never a failure, once the switch was off), and
`server/routes/support.ts` (licence state in the support bundle).

## What removal changes

- Every optional module becomes unconditional. `resolve()` no longer takes
  entitlements and `missing-entitlement` leaves the `Problem` union.
- `licence.paseto` and `heartbeat.json` stop being written. Existing files are
  left on disk, harmless and ignored.
- `clock.json` goes with it — the monotonic clock existed only to stop grace
  being wound back, and with no grace there is nothing to defend.

## Bringing it back

The design above is the specification. Three things would need re-deciding
rather than restoring:

1. **The trust root.** The embedded public key's private half is in the
   `qanoontech-licence` repository and is unchanged; any restored build must
   embed the matching public key or every existing token fails.
2. **Grace and enforcement.** `LICENCE_ENFORCED` was `false` at removal, so the
   enforcement path had not been exercised recently. It has tests, but a live
   deployment being stopped by it should be rehearsed on `.106` before any firm
   sees it.
3. **The two boxes already hold tokens.** `.106` and `.18` both have a valid
   `licence.paseto` at the time of removal. A restored implementation would
   accept them, so the return path does not start from nothing.

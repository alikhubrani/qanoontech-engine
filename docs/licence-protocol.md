# Licence protocol

**Status: implemented in the engine; the licence service that answers it is
not yet built.** This document is the contract between the two, written from
the engine's side, which is the side that cannot be changed retroactively
across deployed boxes.

## The licence

A PASETO `v4.public` token, signed with our Ed25519 issuing key. The engine
carries the public key compiled into its image and verifies offline — a firm's
system never needs our infrastructure to *run*.

Payload, version 1:

| claim | meaning |
| --- | --- |
| `v` | payload version. `1`. A higher version than the engine knows means "update the engine", not "invalid" |
| `licenceId` | unique per issued licence |
| `firmId`, `firmName` | whose it is; the name is shown in the panel |
| `issuedAt`, `expiresAt` | ISO 8601 |
| `entitlements` | catalogue entitlement keys, e.g. `module.ocr` |
| `seats` | permitted active users; `0` is unlimited |
| `heartbeat.url` | where to phone |
| `heartbeat.intervalHours` | how often a confirmation is expected |
| `heartbeat.graceDays` | how long decay is tolerated before enforcement |
| `override` | see below |

## The heartbeat

`POST heartbeat.url` with `{ "licenceId", "firmId" }`. Nothing else leaves the
box — no usage, no counts, no client data.

The response body is itself a PASETO `v4.public` signed by the same key:

```json
{ "v": 1, "licenceId": "…", "status": "ok" | "revoked", "at": "<ISO 8601>" }
```

Rules the engine enforces, and why:

- **Unsigned, wrongly signed, or mismatched `licenceId` → treated as no
  answer.** An unsigned "ok" is an "ok" anyone between the box and us can
  manufacture, and with it revocation is theatre.
- **`at` older than 7 days → treated as no answer.** Otherwise one captured
  "ok" is replayable forever.
- **`at` also ratchets the engine's monotonic clock.** Every heartbeat carries
  a timestamp the operator cannot wind back.
- **Every failure fails the same direction: toward enforcement.** Blocking the
  URL — the attacker's easy move — only starts the grace clock, with
  escalating warnings on it.

## Grace and enforcement

Grace starts at the earliest of: expiry, revocation, or the last confirmed
heartbeat plus the interval. For a box that has never phoned in, the clock
starts at `issuedAt` — a firewalled box is not a box with an unrevokable
licence. Time is measured against a monotonic high-water mark; time that has
been seen has elapsed, whatever the system clock claims.

Past `graceDays`, the engine stops `app`, `nginx` and every optional module.
It does not touch `postgres`, itself, backups, restore or export. The firm
cannot work; the firm can always get its records out.

## The override

A licence with `override: true` answers to nothing but its own expiry: no
heartbeat, no grace. It exists for the day enforcement fired for a reason that
turned out to be ours — issued over the phone, installed in the panel, working
in minutes. It is short-lived *by construction*: an override with a long life
would be a licence that cannot be revoked, so the issuing tool should never
sign one for more than days.

## Issuing (until the licence service exists)

```bash
npx tsx scripts/sign-licence.ts keygen > keypair.json     # once, kept off-repo
npx tsx scripts/sign-licence.ts sign keypair.json claims.json
```

The private key never enters this repository. The public key embedded in
`src/licence/format.ts` is a development placeholder whose private half is
kept nowhere; **replacing it with the real issuing key is a release-checklist
step**, and until that happens every real-world licence check fails closed.

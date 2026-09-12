# Operator sign-in: Entra instead of a password

**Status: proposed, 2026-09-12. Nothing built.**

The engine's web panel is guarded by one operator password. This proposes
replacing it with Microsoft Entra sign-in against a single tenant, and states
the one rule that has to hold or the change makes the system less recoverable
rather than safer.

---

## 1. What exists now, measured

Read before trusting this section: `src/server/auth.ts`, `src/server/routes/session.ts`,
and the pre-handler in `src/server/index.ts`.

`AuthStore` is better than "a password in a file" and worth saying so, because
the argument for changing it is not that it was done badly:

- scrypt at OWASP's parameters (N=2^17, r=8, p=1) with a per-install salt,
  in `auth.json`.
- A lockout after 5 failures, in `throttle.json` — **durable**, so it survives
  the restart an attacker would otherwise use to reset the counter.
- Sessions in `sessions.json` holding the **sha256 of the token**, never the
  token. Idle 2 hours, absolute 24.
- One pre-handler in `src/server/index.ts` refuses every route without a valid
  session cookie, so protection is not per-route and cannot be forgotten on a
  new one.

What none of that fixes is the shape of the credential itself:

| | today |
| --- | --- |
| factors | one |
| holders | everyone who has been told it, indefinitely |
| rotation | manual, and nothing prompts it |
| revocation | change it and tell everyone again |
| attribution | none — every action is "the operator" |
| on compromise | no signal, anywhere |

And what it guards is the whole estate: `DB_PASSWORD`, `JWT_SECRET`,
`JWT_REFRESH_SECRET`, `SETTINGS_ENCRYPTION_KEY`, `GHCR_TOKEN`, the R2 key pair,
and the mailer's Microsoft secret. The panel can deploy, restore over the live
database, and read every module's configuration. It is the highest-value single
credential in the system and the least defended.

## 2. What Entra buys

MFA and conditional access without building either. Revocation that is central
and immediate — disable the account and the panel is shut, everywhere, without
touching a box. Per-person attribution in the audit trail, which today reads
"the operator" for every entry. Sign-in logs on Microsoft's side, including the
failures nobody currently sees. And no password on the box at all: `auth.json`
stops being a thing worth stealing.

Restricting to one tenant and an explicit user assignment means a leaked
anything is no longer sufficient.

## 3. The danger, stated before the design

**The engine exists to work when everything else does not.** That is §3 of
`engine-as-a-product.md` and it is why this codebase hand-rolls SMTP rather than
take `nodemailer`, hand-rolls SigV4 rather than take the AWS SDK, and why
`offsite fetch` moved into the CLI on 2026-09-12 — a recovery path reachable
only from a web page is not a recovery path.

Entra inverts that. It makes signing in depend on: Microsoft being up, the
tenant being intact, the app registration's secret not having quietly expired,
DNS resolving, and the box having internet. Every one of those is *less* likely
to hold during a recovery than on an ordinary Tuesday.

The sharpest form: **Phase 2's acceptance test is recovering onto a fresh VM.**
An engine that needs Entra to let you in is an engine that needs a third party
to be healthy before you can rebuild the firm — at the exact moment things are
demonstrably not healthy.

## 4. The rule that resolves it

The reason this is safe to do is already true and was not designed for this:

**The CLI authenticates zero times.** There is no session check anywhere in
`src/cli.ts`, and that is correct — reaching it requires `docker exec` on the
box, which means root-equivalent access to the machine already. The shell *is*
the authentication, and adding a second one there would be theatre.

So the layering is:

| surface | guarded by | role |
| --- | --- | --- |
| web panel | Entra | convenience, and the everyday path |
| CLI | root on the box | **recovery, and the path that must never need a network** |

From which the rule:

> **No operation may be panel-only.** Every capability the panel offers must
> have a CLI equivalent, or Entra becomes a single point of failure for
> recovery rather than a lock on the front door.

This is a live constraint, not a slogan: **Phase 5 is "the panel takes
responsibility"**, which is precisely the phase that would otherwise create
panel-only operations. Phase 5 must be read with this rule in hand.

**And no local break-glass password.** The obvious instinct — keep the password
as an emergency fallback — reintroduces exactly the credential being removed,
and a fallback that is never used is a fallback that is never rotated and never
noticed when it leaks. The CLI is the break-glass. If the panel is unreachable,
the answer is a shell on the box, which is the same access level the panel's
holder effectively has anyway.

## 5. Design

**Flow: authorization code with PKCE**, not the client-credentials flow the
mailer uses. Those are different grants and this is worth being clear about,
because the similarity is misleading: `catalogue/modules/email.ts` authenticates
*as an application* with no human present. Sign-in authenticates *a person*, in
a browser, with a redirect. The tenant is shared, the app-registration concept
is shared, and the engine's existing habit of holding a Microsoft client secret
is shared. The protocol code is not.

**Verify the token on the box.** Fetch the tenant's JWKS, cache it, and check
signature, `iss`, `aud`, `exp`, `nbf`, and `tid` against the configured tenant.
A token that merely decodes is not a token that is for this deployment.

**Allow-list, not just tenant.** `tid` alone admits everyone in the tenant. The
setting is a list of object ids (`oid`) — not UPNs, which can be renamed and
reassigned. Empty list means nobody, never everybody.

**Sessions stay as they are.** Entra decides *who*; `AuthStore`'s session table,
cookie handling, and idle/absolute lifetimes are unchanged and already correct.
The Entra identity is exchanged for a normal engine session on the way in, so
the pre-handler in `src/server/index.ts` needs no change at all.

**The audit gains a subject.** `AuditEntry` carries `address` today. Add the
`oid` and the UPN at sign-in so `deploy-started` names a person.

**Settings** (`state/store.ts`): `authMode: 'password' | 'entra'` defaulting to
`password` so no existing deployment changes under its firm; `entraTenantId`,
`entraClientId`, `entraAllowedObjectIds`. Secret: `ENTRA_CLIENT_SECRET`.

**Switching is a CLI operation**, deliberately: `engine auth use-entra` and
`engine auth use-password`. Configuring the lock from behind the door it locks
is how a deployment gets locked out of itself.

## 6. What the app registration needs

On `alikhubrani.com`'s tenant:

- A **Web** platform registration with redirect URI
  `https://<engine host>/api/session/entra/callback`. Not SPA — the code
  exchange happens server-side so the client secret never reaches a browser.
- **No API permissions.** Sign-in needs identity, not Graph. The engine reads
  claims from the ID token and asks Microsoft for nothing else. Anything granted
  here is blast radius bought for nothing.
- **User assignment required** set on the enterprise application, with exactly
  the intended people assigned.
- A client secret, and **its expiry written down**. The mailer's equivalent is
  already a known operational trap: when that secret lapses the mailer stops.
  When *this* one lapses, the panel stops — which is survivable only because of
  §4's rule, and is the best argument for it.

## 7. Acceptance

On `.106`, and none of it passes on staging alone — item 5 is the one that
matters and it is the same fresh VM as Phase 2.

1. `engine auth use-entra` with tenant, client id and one allowed `oid`. Sign in
   with that account. Land on the panel.
2. A second account **in the same tenant** but not on the allow-list is refused.
3. A token from a different tenant is refused.
4. Disable the account in Entra; the next sign-in fails and the existing session
   is no longer honoured after its idle window.
5. **Pull the box's internet.** Confirm every operation still runs from the CLI:
   `status`, `backup now`, `backup drill`, `offsite list`, `backup restore`.
   This is the test the whole design rests on.
6. `engine auth use-password` restores the old behaviour, proving the change is
   not one-way.

## 8. Open questions

1. **Does the panel ever face the internet?** It binds per `bindAddress` and is
   reached on port 8081 on the LAN today. If it stays LAN-only, Entra is defence
   in depth rather than perimeter, and the redirect URI needs a reachable host
   anyway — which may mean the tunnel module, and that is a new exposure to
   decide on deliberately rather than acquire as a side effect.
2. **One registration per deployment, or one shared?** Shared is less to manage
   and makes a single secret expiry take down every firm's panel at once.
3. **Does the licence server want the same treatment?** It holds the signing key
   for every entitlement in the estate and is out of scope here, but it is the
   other high-value single credential and the reasoning transfers.

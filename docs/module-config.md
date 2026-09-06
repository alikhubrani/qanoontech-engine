# Module configuration: how a module describes itself to the panel

**Status: implemented with this change.**

The panel must never ask an operator for raw JSON. A module that needs a
Shared Drive ID and a service-account key asks for exactly those two things,
by name, with help text — and the only way that stays true as modules are
added is if the module *itself* is the description the form is rendered from.

## One source of truth, two derived views

A module's zod config schema (`catalogue/modules/*.ts`) remains the single
definition — the same schema that validates at resolve time and on every
save. Two things are derived from it, never written separately:

1. **Validation** — unchanged: `resolve()` and `PUT /api/modules/:id/config`
   parse against it.
2. **The form** — `z.toJSONSchema(module.config, { io: 'input' })` is exposed
   as `configSchema` on `GET /api/modules`, and the panel renders fields from
   it: `string` → text input, `integer`/`number` → number input, `boolean` →
   switch, `enum` → select, array-of-enum → checkbox group. Field labels and
   help text come from `.meta({ title, description })` on the schema — put
   them there, not in the UI.

A module whose config is `z.void()` has `configSchema: null` and renders no
form. Hand-written field lists in the UI are the two-catalogues bug wearing
a new hat; do not add one.

## Secrets are declared, and write-only

Config is a value the operator may read back. A credential is not — so
secrets travel a separate path with different rules:

- A module declares what it needs:

  ```ts
  secrets: [{
    name: 'GOOGLE_SERVICE_ACCOUNT_KEY',
    title: 'Service account key',
    help: 'The JSON key file for the service account…',
    kind: 'json',            // 'json' | 'token' | 'text' — picks the input widget
  }]
  ```

- `GET /api/modules` reports each declared secret with a `set: boolean` and
  **never a value**.
- `PUT /api/modules/:id/secrets` accepts `{ values: { NAME: '…' } }`,
  refuses any name the module does not declare, writes to the engine's
  secret store, and echoes nothing back. Replacing a secret is the same
  call; there is no read path, by design.
- The renderer keeps its own independent check: a module whose secret is
  unset still refuses to render, whatever the declarations say. The
  declaration is for the form and for early, well-worded errors — it is not
  the enforcement.

### Optional secrets

A secret declared with `optional: true` is one the module can run without —
`render` asks for it only in the configurations that need it. `SMTP_PASSWORD`
on the email module is the example: it is demanded only when an SMTP user is
set, so a firm relaying through an internal server that takes no credentials
is not refused over a password it has no use for.

What optional changes, exactly:

- **Renderer.** A *required* declared secret that is unset refuses the render
  whether or not `render` happened to read it — the declaration is a contract,
  and a module cannot declare a secret and then quietly ship without it. An
  *optional* one is refused only at the moment `render` actually calls
  `ctx.secret()` for it, so with the feature off nothing is demanded and with
  it on the error names the secret as usual. A secret missing both ways is
  reported once.
- **`GET /api/modules`** reports `optional: boolean` on each declared secret.
- **`PUT /api/modules/:id/secrets`** accepts an empty value for an optional
  secret and removes it from the store. A required secret can be replaced
  but never cleared; an empty value for one is refused.

## Rules

- Labels, help text, defaults, ranges: **on the zod schema**, via `.meta()`
  and the constraints themselves. If the form is wrong, fix the schema.
- The generated-secrets set (`DB_PASSWORD`, JWT keys…) is not declarable
  here and never gets a form: nobody types those, so no field may exist that
  would let someone try.
- A new module with config that the field renderer cannot draw is a renderer
  gap to fix, not a reason to fall back to a JSON textarea.

## Email: a module, not a setting

`email` (`catalogue/modules/email.ts`) is the mailer container, modelled on
the drive mirror: optional, off by default, entitled by `module.email`,
reading the application database (it drains an outbox table the application
writes) and mounting no volume. It is a container rather than settings on the
application because the application never holds SMTP credentials, never
blocks a request on a mail server, and a mail outage is this container's logs
and memory limit rather than the application's. The application discovers it
the way it discovers OCR — by asking whether it answers; there is no flag.

Config fields, all with `.meta()` labels: `smtpHost` (required), `smtpPort`
(default 587), `smtpSecure` (default off; TLS from the first byte on 465,
STARTTLS on 587), `smtpUser` (optional), `fromAddress` (required, an email
address). One secret, `SMTP_PASSWORD`, optional as above.

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

## Rules

- Labels, help text, defaults, ranges: **on the zod schema**, via `.meta()`
  and the constraints themselves. If the form is wrong, fix the schema.
- The generated-secrets set (`DB_PASSWORD`, JWT keys…) is not declarable
  here and never gets a form: nobody types those, so no field may exist that
  would let someone try.
- A new module with config that the field renderer cannot draw is a renderer
  gap to fix, not a reason to fall back to a JSON textarea.

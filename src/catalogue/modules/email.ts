import { z } from 'zod'
import { defineModule } from '../types.js'

/**
 * The mailer: reminders and hearing changes, sent through the firm's own SMTP
 * relay.
 *
 * A container rather than settings on the application, and the reasons are
 * boundaries, not taste. The application never holds SMTP credentials — the
 * password is typed once, here, and reaches only this container. The
 * application never blocks a request on a mail server: it writes a row to an
 * outbox table in the shared database and moves on, and this container drains
 * it. And a mail outage is this container's logs and this container's memory
 * limit, not the application's.
 *
 * The application discovers it the way it discovers OCR — by asking whether
 * it answers. There is no flag anywhere saying email is on; the container
 * existing *is* the fact.
 *
 * Two ways to authenticate. `basic` is a username and password, and stays the
 * default so an existing box does not change behaviour when it takes a new
 * image. `oauth-microsoft` is the client-credentials flow against Entra, which
 * Microsoft requires from 2027 and which is the only way to send as an
 * unlicensed shared mailbox. The Exchange side of that needs App RBAC and — a
 * genuine trap — the app registration must be granted *no* API permissions at
 * all; see docs/spec/email-oauth-microsoft.md in qanoontech-app.
 */

/*
 * Flat, with a mode enum, rather than a discriminated union — and that is a
 * constraint, not a preference. The Deploy page builds its form from
 * `z.toJSONSchema(module.config)` (src/server/routes/deploy.ts) and
 * ui/src/components/module-form.tsx walks `schema.properties`. A union comes
 * out of `toJSONSchema` as `anyOf`, which that renderer draws as **nothing at
 * all** — a module whose configuration silently cannot be entered. So: an
 * enum the renderer turns into a select, optional fields beside it, and a
 * superRefine that demands the right ones. Do not tidy this into a union
 * without changing the form first.
 */
const config = z
  .object({
    smtpHost: z.string().min(1).meta({
      title: 'SMTP host',
      description: 'The relay the mailer sends through, e.g. smtp.office365.com.',
    }),
    smtpPort: z.number().int().min(1).max(65_535).default(587).meta({
      title: 'SMTP port',
      description: '587 for STARTTLS (the usual), 465 for TLS from the first byte.',
    }),
    smtpSecure: z.boolean().default(false).meta({
      title: 'TLS from the first byte',
      description: 'TLS from the first byte (465); off for STARTTLS on 587.',
    }),
    authMode: z.enum(['basic', 'oauth-microsoft']).default('basic').meta({
      title: 'Authentication',
      description:
        'basic: a username and password. oauth-microsoft: Microsoft 365 with an app registration — required from 2027, and the only way to send as an unlicensed shared mailbox.',
    }),
    smtpUser: z.string().min(1).optional().meta({
      title: 'SMTP user or mailbox',
      description:
        'With basic, the account the relay authenticates and its password under secrets. With Microsoft OAuth, the mailbox to send as. Leave empty only for a relay that takes no credentials.',
    }),
    oauthTenantId: z.string().min(1).optional().meta({
      title: 'Microsoft tenant id',
      description: 'Directory (tenant) ID from Entra. Microsoft OAuth only.',
    }),
    oauthClientId: z.string().min(1).optional().meta({
      title: 'Microsoft application id',
      description:
        'Application (client) ID of the app registration. Grant it no API permissions — see docs. Microsoft OAuth only.',
    }),
    fromAddress: z.email().meta({
      title: 'Sender address',
      description:
        'The address recipients see the email from. With Microsoft OAuth this should be the mailbox above; anything else needs SendAs granted in Exchange.',
    }),
  })
  .superRefine((value, ctx) => {
    if (value.authMode !== 'oauth-microsoft') return
    // Refused here rather than discovered by a mailer that boots unhealthy.
    for (const field of ['smtpUser', 'oauthTenantId', 'oauthClientId'] as const) {
      if (!value[field]) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: 'Required when authentication is Microsoft OAuth.',
        })
      }
    }
  })

export const email = defineModule({
  id: 'email',
  title: 'Email notifications',
  summary: 'Sends reminders and hearing changes by email through the firm’s SMTP relay.',
  required: false,
  defaultEnabled: false,
  entitlement: 'module.email',
  image: { kind: 'versioned', repository: 'ghcr.io/alikhubrani/qanoontech-mailer' },
  cost: { image: '~180 MB', memory: '256M', cpus: '0.25' },
  requires: ['app', 'postgres'],
  config,
  secrets: [
    {
      name: 'SMTP_PASSWORD',
      title: 'SMTP password',
      help: 'The password for the SMTP user, when authentication is basic. A relay that takes no credentials needs none, and Microsoft OAuth uses the client secret below instead.',
      kind: 'token',
      // Demanded by render only when there is a user to authenticate. A relay
      // that trusts the network is a real configuration, not a mistake, and
      // must not be refused over a password it has no use for.
      optional: true,
    },
    {
      name: 'SMTP_OAUTH_SECRET',
      title: 'Microsoft client secret',
      help: 'The client secret from the app registration. Needed only with Microsoft OAuth. Note its expiry — when it lapses the mailer stops and the email module reads as unhealthy.',
      kind: 'token',
      optional: true,
    },
  ],
  // No uploads: it sends text about documents, never the documents.
  volumes: [],
  render: (ctx) => ({
    image: `ghcr.io/alikhubrani/qanoontech-mailer:${ctx.version}`,
    restart: 'unless-stopped',
    environment: {
      // The same database the application uses: the queue is outbox rows the
      // application writes. Like the drive mirror, this is an
      // application-family component — it is the *engine* that never holds a
      // database connection, not this container.
      DATABASE_URL:
        `postgresql://${ctx.settings.dbUser}:${ctx.secret('DB_PASSWORD')}` +
        `@postgres:5432/${ctx.settings.dbName}?schema=public`,
      SMTP_HOST: ctx.config.smtpHost,
      SMTP_PORT: String(ctx.config.smtpPort),
      SMTP_SECURE: ctx.config.smtpSecure ? 'true' : 'false',
      SMTP_AUTH_MODE: ctx.config.authMode,
      // Credentials travel together or not at all, in whichever shape the
      // chosen mode uses. The password is not sent in OAuth mode: an unused
      // secret in a container's environment is one more thing to leak.
      ...(ctx.config.authMode === 'oauth-microsoft'
        ? {
            SMTP_USER: ctx.config.smtpUser!,
            SMTP_OAUTH_TENANT: ctx.config.oauthTenantId!,
            SMTP_OAUTH_CLIENT_ID: ctx.config.oauthClientId!,
            SMTP_OAUTH_SECRET: ctx.secret('SMTP_OAUTH_SECRET'),
          }
        : ctx.config.smtpUser !== undefined
          ? { SMTP_USER: ctx.config.smtpUser, SMTP_PASSWORD: ctx.secret('SMTP_PASSWORD') }
          : {}),
      SMTP_FROM: ctx.config.fromAddress,
      PORT: '3004',
      TZ: ctx.settings.timezone,
    },
    healthcheck: {
      test: ['CMD', 'wget', '--quiet', '--tries=1', '--spider', 'http://localhost:3004/health'],
      interval: '60s',
      timeout: '10s',
      retries: 3,
    },
  }),
})

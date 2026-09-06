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
 */
const config = z.object({
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
  smtpUser: z.string().min(1).optional().meta({
    title: 'SMTP user',
    description:
      'The account the relay authenticates, with its password under secrets. Leave empty for a relay that takes no credentials.',
  }),
  fromAddress: z.email().meta({
    title: 'Sender address',
    description: 'The address recipients see the email from. The relay must be allowed to send as it.',
  }),
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
      help: 'The password for the SMTP user. Needed only when an SMTP user is set; a relay that takes no credentials needs none.',
      kind: 'token',
      // Demanded by render only when there is a user to authenticate. A relay
      // that trusts the network is a real configuration, not a mistake, and
      // must not be refused over a password it has no use for.
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
      // Credentials travel together or not at all.
      ...(ctx.config.smtpUser !== undefined
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

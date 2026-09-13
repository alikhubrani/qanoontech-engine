import { z } from 'zod'
import { defineModule } from '../types.js'

/**
 * The application: Next.js and the Express API in one image.
 *
 * NEXT_PUBLIC_API_URL is deliberately absent. Next inlines NEXT_PUBLIC_* into
 * the browser bundle at build time, so a value set here arrives too late to
 * take effect. The client uses the relative path /api, which nginx proxies on
 * the same origin — correct on any hostname, including through the tunnel.
 */
export const app = defineModule({
  id: 'app',
  title: 'QanoonTech',
  summary: 'The application itself. Cases, clients, documents, tasks.',
  required: true,
  defaultEnabled: true,
  image: { kind: 'versioned', repository: 'ghcr.io/alikhubrani/qanoontech' },
  cost: { image: '~600 MB', memory: '2G', cpus: '2' },
  requires: ['postgres'],
  config: z.void(),
  secrets: [
    {
      name: 'DATABASE_URL',
      title: 'Database URL',
      help: 'Set only when the database lives outside this deployment — a VM, a managed service. Leave unset to use the postgres module. Configure it with `database use`, not here.',
      kind: 'token',
      optional: true,
    },
  ],
  volumes: ['uploads_data', 'logs_data', 'document_fonts'],
  render: (ctx) => {
    const { settings } = ctx
    const dbPassword = ctx.secret('DB_PASSWORD')
    return {
      image: `ghcr.io/alikhubrani/qanoontech:${ctx.version}`,
      restart: 'unless-stopped',
      environment: {
        // The stored URL when the database is elsewhere, else the compose
        // module by name. A supplied URL is handed on exactly as given —
        // whoever wrote it knows their server.
        DATABASE_URL:
          ctx.optionalSecret('DATABASE_URL') ??
          `postgresql://${settings.dbUser}:${dbPassword}` +
            `@postgres:5432/${settings.dbName}?schema=public`,
        NODE_ENV: 'production',
        PORT: '3000',
        API_PORT: '3001',
        API_URL: 'http://app:3001/api',
        JWT_SECRET: ctx.secret('JWT_SECRET'),
        JWT_REFRESH_SECRET: ctx.secret('JWT_REFRESH_SECRET'),
        JWT_EXPIRES_IN: '15m',
        JWT_REFRESH_EXPIRES_IN: '30d',
        // Encrypts integration credentials before they reach the database.
        SETTINGS_ENCRYPTION_KEY: ctx.secret('SETTINGS_ENCRYPTION_KEY'),
        UPLOAD_DIR: '/app/uploads',
        MAX_FILE_SIZE: String(settings.maxFileSizeBytes),
        BCRYPT_ROUNDS: '12',
        LOG_LEVEL: settings.logLevel,
        LOG_FILE: '/app/logs/app.log',
        DEFAULT_LANGUAGE: settings.defaultLanguage,
        TZ: settings.timezone,
        // Where the application renders documents to PDF. It uses this because
        // the container answers, not because a flag says so.
        GOTENBERG_URL: 'http://gotenberg:3000',
        // And where it queues email. Named here rather than left to the
        // application's default, which was `mailer` -- a host no deployment
        // has, since this catalogue calls the module `email`. The probe failed,
        // the application concluded there was no email module, and nothing was
        // ever queued. Set unconditionally: the module being off means nothing
        // answers, which is exactly what the application checks for, so there
        // is no need to read another module's state to decide.
        MAILER_URL: 'http://email:3004',
      },
      volumes: [
        { volume: 'uploads_data', path: '/app/uploads' },
        { volume: 'logs_data', path: '/app/logs' },
        /*
         * Fonts the firm uploads, written here and read by the renderer.
         * Writable on this side and read-only on Gotenberg's, because one
         * writer is what keeps "which process put this face here" answerable.
         */
        { volume: 'document_fonts', path: '/app/document-fonts' },
      ],
      healthcheck: {
        test: [
          'CMD',
          'node',
          '-e',
          "require('http').get('http://127.0.0.1:3001/api/health'," +
            'r=>process.exit(r.statusCode===200?0:1))' +
            '.on(\'error\',()=>process.exit(1))',
        ],
        interval: '30s',
        timeout: '10s',
        retries: 3,
        startPeriod: '60s',
      },
    }
  },
})

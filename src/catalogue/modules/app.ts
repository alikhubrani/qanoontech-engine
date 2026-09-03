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
  secrets: [],
  volumes: ['uploads_data', 'logs_data'],
  render: (ctx) => {
    const { settings } = ctx
    const dbPassword = ctx.secret('DB_PASSWORD')
    return {
      image: `ghcr.io/alikhubrani/qanoontech:${ctx.version}`,
      restart: 'unless-stopped',
      environment: {
        DATABASE_URL:
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
      },
      volumes: [
        { volume: 'uploads_data', path: '/app/uploads' },
        { volume: 'logs_data', path: '/app/logs' },
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

import { z } from 'zod'
import { defineModule } from '../types.js'

/**
 * The database.
 *
 * Pinned to a major version, and the pin is not a detail. A major-version jump
 * leaves a data directory the new binary refuses to open, and the firm meets it
 * as an outage rather than as an upgrade. Moving Postgres is a dump and a
 * restore, done deliberately, never by editing a tag.
 */
export const postgres = defineModule({
  id: 'postgres',
  title: 'Database',
  summary: 'PostgreSQL. Holds every case, client and document record.',
  required: true,
  defaultEnabled: true,
  image: { kind: 'pinned', reference: 'postgres:15-alpine' },
  cost: { image: '~250 MB', memory: '2G', cpus: '2' },
  requires: [],
  config: z.void(),
  volumes: ['postgres_data'],
  render: (ctx) => ({
    image: 'postgres:15-alpine',
    restart: 'unless-stopped',
    environment: {
      POSTGRES_DB: ctx.settings.dbName,
      POSTGRES_USER: ctx.settings.dbUser,
      POSTGRES_PASSWORD: ctx.secret('DB_PASSWORD'),
      POSTGRES_INITDB_ARGS: '--encoding=UTF8 --locale=en_US.UTF-8',
      TZ: ctx.settings.timezone,
    },
    volumes: [{ volume: 'postgres_data', path: '/var/lib/postgresql/data' }],
    healthcheck: {
      test: ['CMD-SHELL', `pg_isready -U ${ctx.settings.dbUser} -d ${ctx.settings.dbName}`],
      interval: '10s',
      timeout: '5s',
      retries: 5,
    },
  }),
})

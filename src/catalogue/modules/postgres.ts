import { z } from 'zod'
import { defineModule } from '../types.js'
import type { DeploymentSettings } from '../types.js'

/**
 * The database.
 *
 * Pinned to a major version, and the pin is not a detail. A major-version jump
 * leaves a data directory the new binary refuses to open, and the firm meets it
 * as an outage rather than as an upgrade. Moving Postgres is a dump and a
 * restore, done deliberately, never by editing a tag -- which is what
 * `database upgrade <major>` does.
 *
 * Each major has its own volume. 15 keeps the name every existing deployment
 * already has (`postgres_data`); 17 is `postgres17_data`. So an upgrade restores
 * into an empty volume and leaves the old one exactly as it was, and going back
 * is setting the major back -- nothing was overwritten to get here.
 */
export type PostgresMajor = 15 | 17

export const POSTGRES_VOLUME: Record<PostgresMajor, string> = {
  15: 'postgres_data',
  17: 'postgres17_data',
}

export function postgresMajorOf(settings: Pick<DeploymentSettings, 'postgresMajor'>): PostgresMajor {
  return settings.postgresMajor ?? 15
}

export const postgres = defineModule({
  id: 'postgres',
  title: 'Database',
  summary: 'PostgreSQL. Holds every case, client and document record.',
  required: true,
  defaultEnabled: true,
  image: { kind: 'pinned', reference: 'postgres:17-alpine' },
  cost: { image: '~250 MB', memory: '2G', cpus: '2' },
  requires: [],
  config: z.void(),
  secrets: [],
  // Both, always: declaring only the one in use would leave the other looking
  // unowned, and the one not in use is the way back after an upgrade.
  volumes: [POSTGRES_VOLUME[15], POSTGRES_VOLUME[17]],
  render: (ctx) => {
    const major = postgresMajorOf(ctx.settings)
    return {
      image: `postgres:${major}-alpine`,
      restart: 'unless-stopped',
      environment: {
        POSTGRES_DB: ctx.settings.dbName,
        POSTGRES_USER: ctx.settings.dbUser,
        POSTGRES_PASSWORD: ctx.secret('DB_PASSWORD'),
        POSTGRES_INITDB_ARGS: '--encoding=UTF8 --locale=en_US.UTF-8',
        TZ: ctx.settings.timezone,
      },
      volumes: [{ volume: POSTGRES_VOLUME[major], path: '/var/lib/postgresql/data' }],
      healthcheck: {
        test: ['CMD-SHELL', `pg_isready -U ${ctx.settings.dbUser} -d ${ctx.settings.dbName}`],
        interval: '10s',
        timeout: '5s',
        retries: 5,
      },
    }
  },
})

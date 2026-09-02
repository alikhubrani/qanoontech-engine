import { z } from 'zod'
import { defineModule } from '../types.js'

/**
 * Copies documents to the firm's own Google Shared Drive, after the fact.
 *
 * Two things about this are deliberate and must not drift.
 *
 * It is a **mirror**, never a storage path. Local disk is the only thing
 * preview, download and thumbnails ever touch. A failure here costs a backup
 * copy, not an upload.
 *
 * It shares a *credential* with the engine's offsite backup copy and nothing
 * else. The engine is the only place the service account key is ever typed; it
 * keeps its own copy for backups and injects it here. The two paths share a
 * transport and no code, because the backup has to work when the application
 * and its database do not — and a restore cannot depend on asking a container
 * that may well be the reason you are restoring.
 */
const config = z.object({
  /** The Shared Drive's id. The service account must be a Content Manager on it. */
  sharedDriveId: z.string().min(1),
  /** Files larger than this are skipped rather than retried forever. */
  maxFileSizeBytes: z.number().int().positive().default(1_073_741_824),
})

export const driveMirror = defineModule({
  id: 'drive-mirror',
  title: 'Offsite document copy',
  summary: 'Copies documents to the firm’s Google Shared Drive after upload.',
  required: false,
  defaultEnabled: false,
  entitlement: 'module.drive-mirror',
  image: { kind: 'versioned', repository: 'ghcr.io/alikhubrani/qanoontech-drive-mirror' },
  cost: { image: '~120 MB', memory: '512M', cpus: '0.5' },
  requires: ['app'],
  config,
  volumes: ['uploads_data'],
  render: (ctx) => ({
    image: `ghcr.io/alikhubrani/qanoontech-drive-mirror:${ctx.version}`,
    restart: 'unless-stopped',
    environment: {
      GOOGLE_SERVICE_ACCOUNT_KEY: ctx.secret('GOOGLE_SERVICE_ACCOUNT_KEY'),
      DRIVE_SHARED_DRIVE_ID: ctx.config.sharedDriveId,
      DRIVE_MAX_FILE_SIZE: String(ctx.config.maxFileSizeBytes),
      PORT: '3003',
      TZ: ctx.settings.timezone,
    },
    // Read-only. It copies out; it never writes back.
    volumes: [{ volume: 'uploads_data', path: '/app/uploads', readOnly: true }],
    healthcheck: {
      test: ['CMD', 'wget', '--quiet', '--tries=1', '--spider', 'http://localhost:3003/health'],
      interval: '60s',
      timeout: '10s',
      retries: 3,
    },
  }),
})

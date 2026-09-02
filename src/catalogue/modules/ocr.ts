import { z } from 'zod'
import { defineModule } from '../types.js'

/**
 * PaddleOCR as a sidecar.
 *
 * Note what this is not: the application already extracts text with `pdftoppm`
 * and `tesseract` inside its own container, and that keeps working whether this
 * is enabled or not. This module is a better recogniser offered to firms whose
 * documents justify two gigabytes, not a replacement switch.
 *
 * The application discovers it by asking whether it answers. There is no flag
 * anywhere saying it is on — the container existing *is* the fact.
 */
/**
 * `prefault({})` matters: every field below has a default, so a firm that
 * enables this without configuring it should get the defaults — not a
 * validation error saying configuration is missing when none was ever needed.
 */
const config = z.object({
  /**
   * Scripts to load models for. Chosen deliberately rather than defaulting to
   * everything: offered both, a recogniser frequently prefers a Latin reading
   * of an Arabic shape, and a Saudi judgment comes back as noise.
   */
  languages: z.array(z.enum(['ar', 'en'])).min(1).default(['ar', 'en']).meta({
    title: 'Languages',
    description: 'Scripts to load recognition models for.',
  }),
  /** Recognition is CPU-bound. More than one on a small box starves the app. */
  maxConcurrency: z.number().int().min(1).max(8).default(1).meta({
    title: 'Concurrent pages',
    description: 'Recognition is CPU-bound; more than one on a small box starves the application.',
  }),
}).prefault({})

export const ocr = defineModule({
  id: 'ocr',
  title: 'Enhanced text recognition',
  summary: 'PaddleOCR. Better Arabic recognition than the built-in extractor.',
  required: false,
  defaultEnabled: false,
  entitlement: 'module.ocr',
  image: { kind: 'versioned', repository: 'ghcr.io/alikhubrani/qanoontech-ocr' },
  cost: { image: '~2 GB', memory: '2G', cpus: '2' },
  requires: ['app'],
  config,
  secrets: [],
  volumes: ['uploads_data'],
  render: (ctx) => ({
    image: `ghcr.io/alikhubrani/qanoontech-ocr:${ctx.version}`,
    restart: 'unless-stopped',
    environment: {
      OCR_LANGUAGES: ctx.config.languages.join(','),
      OCR_MAX_CONCURRENCY: String(ctx.config.maxConcurrency),
      PORT: '3002',
      TZ: ctx.settings.timezone,
    },
    // Read-only: it reads a page and returns text. It has no business writing
    // to the volume holding the firm's documents.
    volumes: [{ volume: 'uploads_data', path: '/app/uploads', readOnly: true }],
    healthcheck: {
      test: ['CMD', 'wget', '--quiet', '--tries=1', '--spider', 'http://localhost:3002/health'],
      interval: '30s',
      timeout: '10s',
      retries: 3,
      startPeriod: '120s',
    },
  }),
})

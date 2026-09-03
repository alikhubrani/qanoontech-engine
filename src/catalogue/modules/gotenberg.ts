import { z } from 'zod'
import { defineModule } from '../types.js'

/**
 * Gotenberg: Chromium behind a pooled HTTP API, for rendering documents to PDF.
 *
 * Required rather than optional, and the reasoning matters: PDF export is a
 * core feature of a legal document system, and once Chromium left the
 * application image the application cannot produce a PDF without this. It is a
 * hard dependency of a core feature — nginx, not OCR — so it is always
 * deployed, carries no entitlement, and cannot be turned off.
 *
 * The application reaches it on the internal network and uses it because it
 * answers; nothing is published, and it holds no credential or client data —
 * HTML goes in, a PDF comes out, and the pooling that a browser-per-request
 * never had comes with it.
 */
export const gotenberg = defineModule({
  id: 'gotenberg',
  title: 'Document rendering',
  summary: 'Renders documents to PDF (Chromium, pooled). Powers export and preview.',
  required: true,
  defaultEnabled: true,
  // Pinned to a major on purpose: it is a third-party image on its own release
  // line, like postgres, and does not move with QanoonTech's version.
  image: { kind: 'pinned', reference: 'gotenberg/gotenberg:8' },
  cost: { image: '~450 MB', memory: '1G', cpus: '1' },
  requires: [],
  config: z.void(),
  secrets: [],
  volumes: [],
  render: (ctx) => ({
    image: 'gotenberg/gotenberg:8',
    restart: 'unless-stopped',
    // Bind to the container network only; the app calls it by name.
    command: ['gotenberg', '--api-port=3000'],
    environment: { TZ: ctx.settings.timezone },
    healthcheck: {
      test: ['CMD', 'curl', '-f', 'http://localhost:3000/health'],
      interval: '30s',
      timeout: '10s',
      retries: 3,
      startPeriod: '20s',
    },
  }),
})

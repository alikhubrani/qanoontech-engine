import { z } from 'zod'
import { defineModule } from '../types.js'

/**
 * Gotenberg: Chromium and LibreOffice behind a pooled HTTP API, for rendering
 * and converting documents to PDF.
 *
 * Required rather than optional, and the reasoning matters: PDF export is a
 * core feature of a legal document system, and once Chromium left the
 * application image the application cannot produce a PDF without this. It is a
 * hard dependency of a core feature — nginx, not OCR — so it is always
 * deployed, carries no entitlement, and cannot be turned off.
 *
 * **It now receives documents the firm uploaded**, not only HTML this system
 * generated. Word-native templates mean a `.docx` a person authored elsewhere
 * is handed to LibreOffice, which is a different threat model from "HTML goes
 * in, a PDF comes out" — see the pin and the deny flags below, and
 * `docs/spec/word-native-templates.md` §3 in the application repository.
 *
 * The application reaches it on the internal network and uses it because it
 * answers; nothing is published, and it holds no credential or client data.
 */
export const gotenberg = defineModule({
  id: 'gotenberg',
  title: 'Document rendering',
  summary: 'Renders and converts documents to PDF (Chromium and LibreOffice, pooled).',
  required: true,
  defaultEnabled: true,
  /*
   * Pinned to a minor line, not to `:8`, and that is a security floor rather
   * than tidiness.
   *
   * CVE-2026-55229 (CVSS 7.5) let a crafted DOCX make LibreOffice fetch
   * external resources during conversion — blind SSRF into the internal
   * network, plus limited local file disclosure. It is fixed in **8.34.0**.
   * `:8` is a moving tag, so a box that pulled it before that release and has
   * not been updated since is still running the vulnerable build; naming a
   * minor line means applying a version cannot leave one there.
   *
   * Moving this pin forward is a deliberate act. Check the release notes.
   */
  image: { kind: 'pinned', reference: 'gotenberg/gotenberg:8.36' },
  cost: { image: '~450 MB', memory: '1G', cpus: '1' },
  requires: [],
  config: z.void(),
  secrets: [],
  /*
   * Fonts the firm uploaded, so a generated document is set in the firm's own
   * face rather than a substitute.
   *
   * The application writes here; this container only reads. It exists because
   * LibreOffice can only use faces present in its own filesystem, and the one
   * font this firm asked for — Calibri — is proprietary and cannot ship in the
   * image. A firm installing a font they are licensed for onto their own server
   * is use, not redistribution, and this volume is what makes that possible.
   *
   * No cache-warming step is needed, which was measured rather than assumed:
   * fontconfig rescans a directory whose contents changed, and the
   * `--libreoffice-restart-after` cycle gives LibreOffice a fresh process that
   * reads it. A new font is therefore live within at most that many
   * conversions, with no `fc-cache`, no container restart, and no need for the
   * application to reach the Docker socket.
   */
  volumes: ['document_fonts'],
  render: (ctx) => ({
    image: 'gotenberg/gotenberg:8.36',
    restart: 'unless-stopped',
    // Bind to the container network only; the app calls it by name.
    command: [
      'gotenberg',
      '--api-port=3000',
      /*
       * Defence in depth behind the pin above. Both flags exist for exactly
       * this deployment: one for "accepts untrusted documents", the other for
       * "air-gapped or data-governed". A firm's box is both.
       *
       * Nothing legitimate needs them off. Every document this system converts
       * is self-contained — the letterhead is embedded as a media part and
       * fonts come from the volume above — so a conversion that reaches for the
       * network is a conversion doing something it was not asked to.
       *
       * LibreOffice-scoped: the Chromium routes are unaffected.
       */
      '--libreoffice-deny-private-ips',
      '--libreoffice-deny-public-ips',
    ],
    environment: { TZ: ctx.settings.timezone },
    volumes: [{ volume: 'document_fonts', path: '/usr/share/fonts/qanoontech', readOnly: true }],
    healthcheck: {
      test: ['CMD', 'curl', '-f', 'http://localhost:3000/health'],
      interval: '30s',
      timeout: '10s',
      retries: 3,
      startPeriod: '20s',
    },
  }),
})

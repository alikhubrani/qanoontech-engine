import { z } from 'zod'
import { defineModule } from '../types.js'

/**
 * The reverse proxy, and the only thing the tunnel talks to.
 *
 * Published on the configured bind address — 0.0.0.0 by default, so the LAN
 * reaches the system out of the box. A firm fronting it with the Cloudflare
 * tunnel narrows the address in settings, deliberately.
 */
export const nginx = defineModule({
  id: 'nginx',
  title: 'Web proxy',
  summary: 'Serves the application and proxies /api. The only thing the tunnel talks to.',
  required: true,
  defaultEnabled: true,
  image: { kind: 'versioned', repository: 'ghcr.io/alikhubrani/qanoontech-nginx' },
  cost: { image: '~60 MB', memory: '512M', cpus: '0.5' },
  requires: ['app'],
  config: z.void(),
  secrets: [],
  volumes: ['uploads_data'],
  render: (ctx) => ({
    image: `ghcr.io/alikhubrani/qanoontech-nginx:${ctx.version}`,
    restart: 'unless-stopped',
    volumes: [{ volume: 'uploads_data', path: '/app/uploads', readOnly: true }],
    ports: [
      {
        host: ctx.settings.bindAddress,
        hostPort: ctx.settings.appPort,
        containerPort: 80,
      },
    ],
    healthcheck: {
      test: ['CMD', 'wget', '--quiet', '--tries=1', '--spider', 'http://localhost/api/health'],
      interval: '30s',
      timeout: '10s',
      retries: 3,
    },
  }),
})

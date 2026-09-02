import { z } from 'zod'
import { defineModule } from '../types.js'

/**
 * The Cloudflare tunnel: the only inbound path to the box.
 *
 * Outbound-only, so the box needs no open port, no port forwarding and no
 * static address. Staff reach the system over WARP; with WARP off it is
 * unreachable.
 *
 * Host networking rather than the internal network, and it is not a
 * preference: advertising a private range means forwarding IP traffic to
 * addresses on the firm's LAN, which a bridge network cannot do. The tunnel's
 * private route therefore targets the address nginx publishes on.
 */
const config = z.object({
  /**
   * The private range advertised to WARP, e.g. '10.77.42.0/24'.
   *
   * Recorded here because it is the one decision that is painful to reverse:
   * 192.168.0.x and 192.168.1.x are the commonest home-router defaults, and an
   * overlap with a staff member's home network makes the system unreachable
   * from that house with no fix available from this side.
   */
  privateRange: z
    .string()
    .regex(/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/, 'Expected CIDR notation, e.g. 10.77.42.0/24')
    .meta({
      title: 'Private range (CIDR)',
      description:
        'The range advertised to WARP, e.g. 10.77.42.0/24. Avoid 192.168.0.x and 192.168.1.x — an overlap with a staff member’s home router makes the system unreachable from that house.',
    }),
})

export const tunnel = defineModule({
  id: 'tunnel',
  title: 'Cloudflare tunnel',
  summary: 'The only inbound path. Staff reach the system through Cloudflare One.',
  required: false,
  defaultEnabled: false,
  entitlement: 'module.tunnel',
  // Pinned rather than versioned: it is not our image and does not move with
  // our releases. `latest` here is a known wart — a `pull` can silently change
  // it — and it should become a digest once we have tested one.
  image: { kind: 'pinned', reference: 'cloudflare/cloudflared:latest' },
  cost: { image: '~40 MB', memory: '256M', cpus: '0.5' },
  requires: ['nginx'],
  config,
  secrets: [
    {
      name: 'CLOUDFLARE_TUNNEL_TOKEN',
      title: 'Tunnel token',
      help: 'From Cloudflare Zero Trust → Networks → Tunnels, when creating the tunnel.',
      kind: 'token',
    },
  ],
  volumes: [],
  render: (ctx) => ({
    image: 'cloudflare/cloudflared:latest',
    restart: 'unless-stopped',
    command: ['tunnel', '--no-autoupdate', '--metrics', '127.0.0.1:2000', 'run'],
    environment: {
      TUNNEL_TOKEN: ctx.secret('CLOUDFLARE_TUNNEL_TOKEN'),
      TZ: ctx.settings.timezone,
    },
    hostNetwork: true,
    healthcheck: {
      test: ['CMD', 'cloudflared', '--version'],
      interval: '60s',
      timeout: '10s',
      retries: 3,
    },
  }),
})

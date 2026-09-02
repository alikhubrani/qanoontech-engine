import type { FastifyReply, FastifyRequest } from 'fastify'

/**
 * The requests the engine refuses before looking at them.
 *
 * Binding to 127.0.0.1 is not the boundary it reads as: a malicious page in
 * the operator's own browser can rebind a domain it controls to 127.0.0.1 and
 * script requests against anything listening there. What defeats that here:
 *
 *   - the Host header must be an address this engine was told it serves on —
 *     a rebound request arrives under the attacker's hostname;
 *   - the session cookie is SameSite=Strict, so a cross-site request carries
 *     no session even if Host were somehow right;
 *   - a state-changing request with an Origin must match a served host — a
 *     browser always names the page that sent it.
 *
 * Nothing trusts the network for being local.
 */

export interface GuardConfig {
  /** Hostnames the engine may be addressed as, without ports. */
  readonly allowedHosts: readonly string[]
}

export function defaultAllowedHosts(bindAddress: string): string[] {
  const hosts = new Set(['127.0.0.1', 'localhost', '::1'])
  if (bindAddress) hosts.add(bindAddress)
  for (const extra of (process.env['ENGINE_ALLOWED_HOSTS'] ?? '').split(',')) {
    const trimmed = extra.trim()
    if (trimmed) hosts.add(trimmed)
  }
  return [...hosts]
}

/** The hostname part of a Host header or an Origin, lowercased, or undefined. */
function hostnameOf(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    // Host headers are not URLs; make one. Brackets survive for IPv6.
    const url = value.includes('://') ? new URL(value) : new URL(`http://${value}`)
    return url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  } catch {
    return undefined
  }
}

export function checkHost(request: FastifyRequest, config: GuardConfig): boolean {
  const hostname = hostnameOf(request.headers.host)
  return hostname !== undefined && config.allowedHosts.includes(hostname)
}

export function checkOrigin(request: FastifyRequest, config: GuardConfig): boolean {
  if (request.method === 'GET' || request.method === 'HEAD') return true
  const origin = request.headers.origin
  // No Origin means no browser sent this — curl, the CLI, a script. Those are
  // not CSRF vectors; they are clients, and authentication still applies.
  if (origin === undefined) return true
  const hostname = hostnameOf(origin)
  return hostname !== undefined && config.allowedHosts.includes(hostname)
}

export function refuse(reply: FastifyReply, status: number, message: string): FastifyReply {
  return reply.status(status).send({ success: false, error: message })
}

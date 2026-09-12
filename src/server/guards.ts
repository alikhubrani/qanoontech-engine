import { isIP } from 'node:net'
import type { FastifyReply, FastifyRequest } from 'fastify'

/**
 * The requests the engine refuses before looking at them.
 *
 * Binding to 127.0.0.1 is not the boundary it reads as: a malicious page in
 * the operator's own browser can rebind a domain it controls to 127.0.0.1 and
 * script requests against anything listening there. What defeats that here:
 *
 *   - the Host header must be an IP literal or a name this engine was told it
 *     serves on. Deployments are LAN-open by design, so any IP the box answers
 *     on is fine — what a DNS-rebinding request can never carry is an IP
 *     literal, because the whole attack is a *domain* the attacker controls
 *     resolving here, and the browser puts that domain in Host;
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

/**
 * Hostnames this engine will answer to.
 *
 * `extra` is where a deployment's own address arrives — the tunnel hostname the
 * panel is reached at. It is **derived from the Entra redirect URI** rather
 * than configured separately, because those two are the same fact: the redirect
 * URI names where a browser comes back to, so that host is by definition how
 * this panel is addressed. Two settings would mean one of them being set and
 * the other forgotten, and the symptom — a 421 after a successful Microsoft
 * sign-in — points nowhere near the cause.
 *
 * `ENGINE_ALLOWED_HOSTS` stays for development and is deliberately **not** the
 * mechanism here: `ENGINE_RUN_ARGS` carries no environment, and self-update
 * removes the container and re-runs it from that constant, so anything set on
 * the container by hand survives exactly until the next update. A setting on
 * the state volume survives; an env var does not.
 */
export function defaultAllowedHosts(bindAddress: string, extra: readonly string[] = []): string[] {
  const hosts = new Set(['127.0.0.1', 'localhost', '::1'])
  if (bindAddress) hosts.add(bindAddress)
  for (const host of extra) {
    const trimmed = host.trim().toLowerCase()
    if (trimmed) hosts.add(trimmed)
  }
  for (const candidate of (process.env['ENGINE_ALLOWED_HOSTS'] ?? '').split(',')) {
    const trimmed = candidate.trim()
    if (trimmed) hosts.add(trimmed)
  }
  return [...hosts]
}

/** The hostname a redirect URI points at, when it is a URL we can read. */
export function hostOfRedirect(redirectUri: string): string[] {
  if (!redirectUri) return []
  try {
    return [new URL(redirectUri).hostname.toLowerCase()]
  } catch {
    return []
  }
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
  if (hostname === undefined) return false
  if (isIP(hostname) > 0) return true
  return config.allowedHosts.includes(hostname)
}

export function checkOrigin(request: FastifyRequest, config: GuardConfig): boolean {
  if (request.method === 'GET' || request.method === 'HEAD') return true
  const origin = request.headers.origin
  // No Origin means no browser sent this — curl, the CLI, a script. Those are
  // not CSRF vectors; they are clients, and authentication still applies.
  if (origin === undefined) return true
  const hostname = hostnameOf(origin)
  if (hostname === undefined) return false
  if (isIP(hostname) > 0) return true
  return config.allowedHosts.includes(hostname)
}

export function refuse(reply: FastifyReply, status: number, message: string): FastifyReply {
  return reply.status(status).send({ success: false, error: message })
}

import type { FastifyInstance } from 'fastify'
import type { AuditKind } from '../audit.js'
import type { ServerContext } from '../context.js'
import { refuse } from '../guards.js'

const KINDS: readonly AuditKind[] = ['security', 'change', 'failure', 'routine']

/**
 * The trail, paged. The overview shows the notable few; this is the whole
 * thing, for the day somebody asks "who restarted the system on the 14th".
 *
 * `before` pages by timestamp rather than by offset, because the file only
 * grows at the end and an offset into it moves every five minutes.
 */
export function auditRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/audit', async (request, reply) => {
    const query = request.query as { limit?: string; before?: string; kinds?: string }
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 500)
    const before = query.before?.trim() || undefined
    if (before !== undefined && Number.isNaN(Date.parse(before))) {
      return refuse(reply, 400, '`before` must be an ISO timestamp.')
    }
    const kinds = query.kinds
      ? query.kinds.split(',').map((kind) => kind.trim()).filter((kind): kind is AuditKind => (KINDS as readonly string[]).includes(kind))
      : undefined
    if (query.kinds && (!kinds || kinds.length === 0)) {
      return refuse(reply, 400, `\`kinds\` must be some of ${KINDS.join(', ')}.`)
    }

    // One more than asked, so "is there another page" is a fact, not a guess.
    const page = ctx.audit.recent({ limit: limit + 1, ...(before ? { before } : {}), ...(kinds ? { kinds } : {}) })
    const entries = page.slice(0, limit)
    return {
      success: true,
      data: {
        entries,
        more: page.length > limit,
        kinds: KINDS,
      },
    }
  })
}

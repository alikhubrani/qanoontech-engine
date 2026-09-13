import type { FastifyInstance } from 'fastify'
import { offsiteClient, pendingOffsite, reconcileOffsite, uploadSet } from '../backup/offsite.js'
import { pushSnapshot, reconcileSnapshot } from '../backup/snapshot.js'
import { NO_STREAK, TICKS_BEFORE_REPORT, advanceStreak, clockOf, type Streak } from '../backup/streak.js'
import { newestBackupAt, newestFullBackupAt, takeBackup } from '../backup/service.js'
import { backupDue } from '../backup/schedule.js'
import { backupHealth } from '../backup/health.js'
import { alertIfNeeded, noteHealthLevel } from '../backup/alert.js'
import { syncDocuments } from '../backup/documents.js'
import { loadState } from '../state/store.js'
import type { ServerContext } from './context.js'
import type { AuditEvent } from './audit.js'

/**
 * The backup loop. The inputs are on disk and the decision is a pure
 * function, so a container recreated on every update loses nothing. A busy
 * flag keeps the tick from stacking a second dump behind a slow one; it is in
 * memory because the thing it guards — a running helper container — dies with
 * the process anyway.
 */

/*
 * Five minutes, because the interval it serves can be five minutes. A tick
 * coarser than the schedule turns "hourly" into "hourly, give or take a
 * quarter of an hour", and the point of the interval is that the number means
 * something.
 *
 * An idle tick is not free, and this comment used to say it was — "two
 * `readdir`s" was true before the drift check and the document sync were
 * attached to it. It now costs one helper container spawn to list the uploads
 * volume and two R2 LIST requests, 288 times a day. Measured and accepted on
 * 2026-09-13: with retention a flat 30 days the set count is bounded at about
 * 76, so both lists stay a single page forever, and the five-minute cadence is
 * what bounds how long a newly uploaded document exists only on this box. A
 * wrong claim about cost is how the next person makes a bad decision
 * confidently, so the number is written down rather than the wish.
 */
const TICK_MS = 5 * 60 * 1000

let running = false

/*
 * The three offsite copies, each with its own run of failed ticks. A run is
 * written to the trail once it has lasted three ticks, and again when it
 * ends; a single tick that could not reach the store is not an event. Eight
 * "fetch failed" rows on a firm's box in one day were each healed by the
 * next tick, and the trail is for what needs a person.
 */
type Copy = 'sets' | 'documents' | 'snapshot'
const COPY_EVENTS: Readonly<Record<Copy, { failed: AuditEvent; recovered: AuditEvent }>> = {
  sets: { failed: 'offsite-failed', recovered: 'offsite-recovered' },
  documents: { failed: 'documents-sync-failed', recovered: 'documents-sync-recovered' },
  snapshot: { failed: 'snapshot-failed', recovered: 'snapshot-recovered' },
}
const streaks: Record<Copy, Streak> = { sets: NO_STREAK, documents: NO_STREAK, snapshot: NO_STREAK }

function noteCopy(ctx: ServerContext, copy: Copy, outcome: { readonly ok: boolean; readonly detail: string }): void {
  const before = streaks[copy]
  const step = advanceStreak(before, outcome, new Date().toISOString())
  streaks[copy] = step.streak
  if (step.event === 'report') {
    ctx.audit.record(COPY_EVENTS[copy].failed, {
      detail: `Failing for ${TICKS_BEFORE_REPORT} ticks, since ${clockOf(step.streak.since ?? '')}. Last: ${step.streak.lastError}`,
    })
  } else if (step.event === 'recovered') {
    ctx.audit.record(COPY_EVENTS[copy].recovered, {
      detail: `Working again after ${before.failures} failed tick(s) since ${clockOf(before.since ?? '')}.`,
    })
  }
}

export async function backupTick(ctx: ServerContext): Promise<void> {
  if (running) return
  const state = loadState(ctx.dir)
  const due = backupDue({
    newestAt: newestBackupAt(ctx.dir),
    newestFullAt: newestFullBackupAt(ctx.dir),
    now: Date.now(),
    backupHour: state.settings.backupHour,
    intervalMinutes: state.settings.backupIntervalMinutes,
    timezone: state.settings.timezone,
  })

  running = true
  try {
    if (due !== 'none') {
      const outcome = await takeBackup('scheduled', ctx.dir, due)
      ctx.audit.record(outcome.ok ? 'backup-taken' : 'backup-failed', { detail: outcome.detail })
    }

    // The offsite copy of the newest set, until it lands. Retried here rather
    // than fired-and-forgotten at take time, so an outage during the night is
    // healed by the next tick rather than by the next backup.
    /*
     * Before choosing what to send, check that what we think went out is still
     * there. A record saying a copy exists is worth nothing if the object was
     * removed afterwards, and until this the engine would never look again.
     */
    const drift = await reconcileOffsite(ctx.dir)
    if (drift.corrected.length > 0) {
      ctx.audit.record('offsite-drift', {
        detail: `${drift.corrected.length} set(s) recorded as copied are not in the store; queued again. Oldest: ${drift.corrected.at(-1)}`,
      })
    }

    const pending = pendingOffsite(ctx.dir)
    if (pending) {
      const sent = await uploadSet(pending, ctx.dir)
      if (sent.ok) ctx.audit.record('offsite-uploaded', { detail: sent.detail })
      noteCopy(ctx, 'sets', sent)
    }

    /*
     * Documents, once each. Independent of the sets: they are shared by all of
     * them and outlive every one that mentions them, so they go on their own
     * schedule and in their own prefix. A batch per tick, so a first run on an
     * established box makes progress without filling the engine's volume.
     */
    if (loadState(ctx.dir).settings.backupOffsiteEnabled) {
      const synced = await syncDocuments(ctx.dir)
      if (synced.ok && synced.sent > 0) ctx.audit.record('documents-synced', { detail: synced.detail })
      noteCopy(ctx, 'documents', synced)
    }

    /*
     * The engine's own state, encrypted, so a dead box is recoverable.
     *
     * Last of the offsite work and unconditional, because it is cheap when
     * nothing has changed — a hash comparison against a local marker, no
     * request at all. A snapshot failing must never stop a backup being taken,
     * so it returns an outcome rather than throwing.
     */
    const store = offsiteClient(ctx.dir).client
    const snapshot = await pushSnapshot(ctx.dir, store, ctx.engineVersion)
    noteCopy(ctx, 'snapshot', snapshot)
    if (snapshot.ok && !snapshot.sent && store) {
      const check = await reconcileSnapshot(ctx.dir, store)
      if (check.missing) {
        ctx.audit.record('snapshot-failed', {
          detail: 'The engine snapshot is not in the store any more; it will be sent again on the next tick.',
        })
      }
    }

    /*
     * And say so when it has stopped.
     *
     * Last, and after the attempt above, so the state reported is the state
     * this tick leaves behind rather than the one it found. A firm's backups
     * stopped for three days with nothing failing anywhere -- the schedule had
     * simply stopped being asked -- so the check is on the *outcome*, not on
     * whether anything threw.
     */
    const health = backupHealth(ctx.dir)
    /*
     * On the way in, not on every tick. This recorded unconditionally and a
     * staging box held one identical line every five minutes -- 288 a day,
     * about one unchanging fact, in a trail that is a few kilobytes and exists
     * to be read.
     */
    const changed = noteHealthLevel(health.level, ctx.dir)
    if (changed && (health.level === 'stale' || health.level === 'none')) {
      ctx.audit.record('backup-stale', { detail: health.detail })
    }
    const alert = await alertIfNeeded(health, ctx.dir)
    if (alert.sent) ctx.audit.record('alert-sent', { detail: alert.detail })
  } finally {
    running = false
  }
}

/**
 * When the schedule was armed, or 0 if it never was.
 *
 * Outside the loop on purpose. Everything that reports on backups is recorded
 * *by* the tick, so a tick that never starts reports nothing and looks exactly
 * like a tick with nothing to do. This is the one fact observable from outside
 * it, and it is what lets a test — or a health check — tell those apart.
 */
let startedAt = 0
export function backupLoopStartedAt(): number {
  return startedAt
}

export function startBackupLoop(app: FastifyInstance, ctx: ServerContext): void {
  startedAt = Date.now()
  const run = () => backupTick(ctx).catch((error) => app.log.error(error, 'backup tick failed'))
  void run()
  const timer = setInterval(run, TICK_MS)
  timer.unref()
  app.addHook('onClose', async () => clearInterval(timer))
}

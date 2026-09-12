import { createConnection, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { loadSecrets, loadState, stateDir } from '../state/store.js'
import { readJsonFile, writeJsonAtomic } from '../lib/json-files.js'
import { join } from 'node:path'
import type { BackupHealth } from './health.js'

/**
 * One email, when the backups stop.
 *
 * A firm's scheduled backups stopped for three days and nothing said so. The
 * audit trail held five `backup-taken` events and no failures, because nothing
 * had failed — the schedule had stopped being asked. Every screen was green,
 * and nobody was looking at a screen anyway. `engine status` and `preflight`
 * now carry the state, and that is right, but both require somebody to already
 * be there. This is the one that arrives.
 *
 * **SMTP spoken directly, not through the application.** The mailer container
 * drains a table in the application's database; writing to it would mean the
 * engine knowing the application's schema, which changes under it on every
 * release, and would mean an alert that goes quiet exactly when the
 * application does. The engine already holds `SMTP_PASSWORD` and already
 * renders `SMTP_HOST`, `SMTP_PORT` and `SMTP_USER` into that container — it
 * configures the firm's relay. It can use it.
 *
 * Hand-rolled rather than `nodemailer`, for the reason `s3.ts` hand-rolls
 * SigV4: this container is what has to work when
 * everything else does not, and one plaintext message over a relay we
 * configured ourselves is a small, closed problem. It speaks enough SMTP to
 * send one message and nothing more — no attachments, no HTML, no queue.
 * Anything richer belongs in the application's mailer, which has one.
 */

const ALERT_FILE = 'alerts.json'
/* One message per problem, not one per tick. Six hours is long enough to be a
 * reminder rather than a flood, and short enough to arrive on a working day. */
const REPEAT_AFTER_MS = 6 * 60 * 60 * 1000

interface AlertRecord {
  /** The health level last reported, so recovery is reported too. */
  level: string
  sentAt: string
}

/**
 * Remember the state, and say whether it is news.
 *
 * The audit trail needs this as much as the mailbox does. `backup-stale` was
 * recorded on every tick, so a box that had been stale for an afternoon held
 * fifty identical lines and a box stale for a week would hold two thousand --
 * in a trail that is 6.8 KB in total and exists to be read. A record that
 * repeats is a record nobody reads, which is the same failure as an alert that
 * repeats, one surface along.
 *
 * Transitions only. The current state is always in `engine status`; the trail
 * is for when it changed. A standing problem still leaves a trail, because the
 * six-hourly reminder records `alert-sent`.
 */
export function noteHealthLevel(level: BackupHealth['level'], dir = stateDir(), now = Date.now()): boolean {
  const last = readAlert(dir)
  if (last?.level === level) return false
  writeJsonAtomic(join(dir, ALERT_FILE), { level, sentAt: last?.sentAt ?? new Date(now).toISOString() })
  return true
}

function readAlert(dir: string): AlertRecord | undefined {
  const raw = readJsonFile(join(dir, ALERT_FILE), { lenient: true })
  return raw && typeof raw === 'object' ? (raw as AlertRecord) : undefined
}

/**
 * Should this state be emailed now?
 *
 * Pure, because the interesting cases are all about *not* sending: the same
 * problem twice in ten minutes, a problem that has not changed since this
 * morning, a box that is simply fine. Exported so those can be tested without
 * a relay.
 */
export function alertDue(input: {
  readonly level: BackupHealth['level']
  readonly last: AlertRecord | undefined
  readonly now: number
}): boolean {
  const { level, last, now } = input
  const bad = level === 'stale' || level === 'none'
  const wasBad = last?.level === 'stale' || last?.level === 'none'

  if (!bad) {
    /*
     * Only a return to `ok` is news, and only after a real problem.
     *
     * This read `last.level !== 'ok'`, which is true of `warn` — so once a box
     * settled at `warn` it announced its own recovery on every tick, forever.
     * Staging sent an email every five minutes until it was muted by hand. The
     * shape of the mistake is worth keeping: "not ok" and "was bad" are not the
     * same set, and `warn` sits in the gap between them.
     */
    if (level !== 'ok') return false
    return wasBad
  }
  if (!last || last.level === 'ok') return true
  if (last.level !== level) return true
  return now - Date.parse(last.sentAt) > REPEAT_AFTER_MS
}

export interface SmtpSettings {
  readonly host: string
  readonly port: number
  readonly secure: boolean
  readonly user?: string | undefined
  readonly password?: string | undefined
  readonly from: string
}

/** The email module's configuration, as the engine stored it. */
export function smtpFromState(dir = stateDir()): SmtpSettings | undefined {
  const state = loadState(dir)
  const config = (state.config as Record<string, Record<string, unknown>> | undefined)?.['email']
  if (!config || typeof config['smtpHost'] !== 'string' || !config['smtpHost']) return undefined
  return {
    host: config['smtpHost'],
    port: Number(config['smtpPort'] ?? 587),
    secure: config['smtpSecure'] === true,
    user: typeof config['smtpUser'] === 'string' ? config['smtpUser'] : undefined,
    password: loadSecrets(dir)['SMTP_PASSWORD'],
    from: typeof config['fromAddress'] === 'string' ? config['fromAddress'] : 'engine@localhost',
  }
}

/** Enough SMTP to send one message: EHLO, optional STARTTLS, optional AUTH, DATA. */
export async function sendMail(
  smtp: SmtpSettings,
  to: string,
  subject: string,
  body: string,
): Promise<void> {
  let socket: Socket | TLSSocket = smtp.secure
    ? tlsConnect({ host: smtp.host, port: smtp.port, servername: smtp.host })
    : createConnection({ host: smtp.host, port: smtp.port })

  const read = (): Promise<string> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The relay did not answer in time.')), 20_000)
      const onData = (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        // A multiline reply ends with `250 ` rather than `250-`.
        if (!/^\d{3}[- ]/m.test(text) || /^\d{3} /m.test(text.split('\n').at(-2) ?? text)) {
          clearTimeout(timer)
          socket.off('data', onData)
          resolve(text)
        }
      }
      socket.on('data', onData)
      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })

  const say = async (line: string, expect = /^[23]\d\d/): Promise<string> => {
    socket.write(`${line}\r\n`)
    const reply = await read()
    if (!expect.test(reply)) throw new Error(`SMTP refused "${line.split(' ')[0]}": ${reply.trim().slice(0, 200)}`)
    return reply
  }

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('secureConnect', () => resolve())
      socket.once('error', reject)
    })
    await read()
    let greeting = await say('EHLO qanoontech-engine')

    if (!smtp.secure && /STARTTLS/i.test(greeting)) {
      await say('STARTTLS')
      const plain = socket as Socket
      socket = tlsConnect({ socket: plain, servername: smtp.host })
      await new Promise<void>((resolve, reject) => {
        socket.once('secureConnect', () => resolve())
        socket.once('error', reject)
      })
      greeting = await say('EHLO qanoontech-engine')
    }

    if (smtp.user && smtp.password) {
      const credential = Buffer.from(`\0${smtp.user}\0${smtp.password}`).toString('base64')
      await say(`AUTH PLAIN ${credential}`)
    }

    await say(`MAIL FROM:<${smtp.from}>`)
    await say(`RCPT TO:<${to}>`)
    await say('DATA', /^3\d\d/)

    const headers = [
      `From: QanoonTech engine <${smtp.from}>`,
      `To: <${to}>`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      `Date: ${new Date().toUTCString()}`,
    ].join('\r\n')
    // Dot-stuffing: a line that is a single dot would otherwise end the message.
    const escaped = body.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..')
    await say(`${headers}\r\n\r\n${escaped}\r\n.`)
    await say('QUIT', /^[23]\d\d/).catch(() => undefined)
  } finally {
    socket.destroy()
  }
}

export interface AlertOutcome {
  readonly sent: boolean
  readonly detail: string
}

/**
 * Send the alert if this state deserves one. Throws never: the caller is the
 * backup tick, and a relay that is down must not stop backups being taken.
 */
export async function alertIfNeeded(
  health: BackupHealth,
  dir = stateDir(),
  now = Date.now(),
  send: typeof sendMail = sendMail,
): Promise<AlertOutcome> {
  const state = loadState(dir)
  const to = state.settings.alertEmail
  if (!to) return { sent: false, detail: 'No alert address is set.' }

  const last = readAlert(dir)
  if (!alertDue({ level: health.level, last, now })) {
    return { sent: false, detail: 'Already reported.' }
  }

  const smtp = smtpFromState(dir)
  if (!smtp) return { sent: false, detail: 'The email module is not configured; nothing can be sent.' }

  const recovered = health.level === 'ok' || health.level === 'warn'
  const subject = recovered
    ? `QanoonTech: backups are running again`
    : `QanoonTech: backups have stopped`

  const body = [
    recovered ? 'Backups are running again.' : 'This deployment has stopped taking backups.',
    '',
    health.detail,
    '',
    `Sets kept: ${health.sets}`,
    `Deployment: ${state.version}`,
    '',
    recovered
      ? ''
      : [
          'What to check, in order:',
          '  docker exec qanoontech-engine node dist/cli.js status',
          '  docker exec qanoontech-engine node dist/cli.js backup list',
          '  docker exec qanoontech-engine node dist/cli.js backup now',
          '',
          'And prove one restores before trusting the list:',
          '  docker exec qanoontech-engine node dist/cli.js backup drill',
        ].join('\n'),
  ].join('\n')

  try {
    await send(smtp, to, subject, body)
    writeJsonAtomic(join(dir, ALERT_FILE), { level: health.level, sentAt: new Date(now).toISOString() })
    return { sent: true, detail: `Alert sent to ${to}.` }
  } catch (error) {
    return { sent: false, detail: `Could not send the alert: ${(error as Error).message.slice(0, 200)}` }
  }
}

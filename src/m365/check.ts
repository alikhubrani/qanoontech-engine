import { X509Certificate, createHash, createPrivateKey, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto'
import { M365_SECRETS } from '../catalogue/modules/app.js'
import type { CheckResult } from '../preflight/index.js'
import { loadSecrets, loadState, stateDir, updateState } from '../state/store.js'

/**
 * Microsoft 365, checked before it is applied.
 *
 * The application has no switch for it any more: it is on exactly when this
 * engine supplies the four `M365_*` secrets, and from that deploy every new
 * file goes to the firm's tenant (qanoontech-app
 * docs/spec/microsoft-365-files.md §4). So the engine is the gate, and a
 * configuration that does not work must be refused here, by name, rather than
 * discovered by a lawyer whose upload fails -- or, worse, by nobody, because
 * an unreachable notification path fails silently: edits made in Word are
 * simply never seen.
 *
 * Each check answers one question Microsoft would otherwise answer later and
 * less clearly: is the set whole, does the key belong to the certificate, will
 * Entra issue a token for it, will Graph list the container type and read the
 * directory, and can Microsoft's handshake reach the application from outside.
 * A check that depends on one that failed is reported as not run rather than
 * left out, so the list is the same shape every time and says why it stopped.
 */

const TITLES = {
  config: 'M365 configuration',
  cert: 'M365 certificate',
  token: 'M365 sign-in',
  graph: 'M365 file storage',
  directory: 'M365 directory',
  sharing: 'M365 sharing',
  address: 'M365 public address',
  notifications: 'M365 notifications',
} as const

const GRAPH = 'https://graph.microsoft.com/v1.0'
const NOTIFICATION_PATH = '/api/m365/notifications'
const REQUEST_TIMEOUT_MS = 15_000
/** Microsoft's own limit for answering the handshake. */
const HANDSHAKE_TIMEOUT_MS = 10_000
const EXPIRY_WARN_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

export type M365Configuration = 'none' | 'partial' | 'complete'

/**
 * Whether the four are set, judged the way the application judges them:
 * trimmed, so a value of whitespace counts as missing. A partial set reaches
 * the application as "not configured", which on a box that has already moved
 * files to Microsoft is an outage, not a fallback.
 */
export function m365Configured(secrets: Record<string, string>): M365Configuration {
  const present = M365_SECRETS.filter((name) => secrets[name]?.trim()).length
  return present === 0 ? 'none' : present === M365_SECRETS.length ? 'complete' : 'partial'
}

function missingSecrets(secrets: Record<string, string>): string[] {
  return M365_SECRETS.filter((name) => !secrets[name]?.trim())
}

/**
 * What a deploy applied, as one hash: the four values and the public address,
 * which is where Microsoft sends notifications and so part of whether the
 * configuration works. JSON rather than concatenation, so no two different
 * sets can run together into the same string.
 */
export function m365Fingerprint(secrets: Record<string, string>, publicUrl: string): string {
  const parts = [...M365_SECRETS.map((name) => secrets[name] ?? ''), publicUrl]
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

export async function checkM365(dir = stateDir(), fetcher: typeof fetch = fetch): Promise<CheckResult[]> {
  const secrets = loadSecrets(dir)
  const { settings } = loadState(dir)
  const configured = m365Configured(secrets)

  if (configured === 'none') {
    return [{ id: 'm365-config', title: TITLES.config, status: 'pass', detail: 'Not configured. Files are kept on this box.' }]
  }

  const results: CheckResult[] = []
  results.push(
    configured === 'complete'
      ? { id: 'm365-config', title: TITLES.config, status: 'pass', detail: 'All four M365_* secrets are set.' }
      : {
          id: 'm365-config',
          title: TITLES.config,
          status: 'fail',
          detail: `Only part of the configuration is set: ${missingSecrets(secrets).join(', ')} missing. The application treats a partial set as not configured, so set all four or clear them all.`,
        },
  )

  // Local, so it runs whenever there is a certificate to read, whole set or not.
  const pem = secrets['M365_CERT_PEM']
  const certificate = pem?.trim() ? checkCertificate(pem) : undefined
  results.push(certificate?.result ?? notRun('m365-cert', TITLES.cert, 'M365_CERT_PEM is not set'))

  let token: string | undefined
  if (configured === 'complete' && certificate?.credential) {
    const outcome = await requestToken(
      secrets['M365_TENANT_ID']!.trim(),
      secrets['M365_CLIENT_ID']!.trim(),
      certificate.credential,
      fetcher,
    )
    results.push(outcome.result)
    token = outcome.token
  } else {
    results.push(
      notRun('m365-token', TITLES.token, configured === 'complete' ? 'the certificate cannot be used' : 'the configuration is incomplete'),
    )
  }

  if (token) {
    results.push(await checkContainers(secrets['M365_CONTAINER_TYPE_ID']!.trim(), token, fetcher))
    results.push(await checkDirectory(token, fetcher))
    results.push(await checkSharing(secrets['M365_CONTAINER_TYPE_ID']!.trim(), token, fetcher))
  } else {
    results.push(notRun('m365-graph', TITLES.graph, 'there is no token to ask Graph with'))
    results.push(notRun('m365-directory', TITLES.directory, 'there is no token to ask Graph with'))
    results.push(notRun('m365-sharing', TITLES.sharing, 'there is no token to ask Graph with'))
  }

  // Independent of the credentials: whether Microsoft can reach the box at all.
  const address = checkAddress(settings.publicUrl)
  results.push(address.result)
  results.push(
    address.base
      ? await checkHandshake(address.base, fetcher)
      : notRun('m365-notifications', TITLES.notifications, 'there is no usable public address to call'),
  )

  return results
}

/*
 * A check that could not run is a `fail`, not a `warn`: the question is
 * whether this configuration works, and unproven is not yes. The detail says
 * which earlier line is the one to fix, so the list does not read as five
 * separate problems.
 */
function notRun(id: string, title: string, because: string): CheckResult {
  return { id, title, status: 'fail', detail: `Not checked: ${because}.` }
}

// -- certificate --------------------------------------------------------------

interface Credential {
  readonly key: KeyObject
  /** base64url SHA-1 of the certificate: the `x5t` Entra finds the key by. */
  readonly x5t: string
}

/**
 * The same parsing the application does (server/storage/m365/graph.ts
 * `loadCredential`), so a PEM this accepts is one the application accepts.
 * The key must belong to the certificate: Entra matches the assertion by the
 * certificate's thumbprint and verifies it with that certificate's public key,
 * so a key from another pair is refused with an error that names neither.
 */
export function checkCertificate(pem: string, now = Date.now()): { result: CheckResult; credential?: Credential } {
  const fail = (detail: string) => ({ result: { id: 'm365-cert', title: TITLES.cert, status: 'fail' as const, detail } })

  const keyPem = pem.match(/-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA )?PRIVATE KEY-----/)?.[0]
  const certPem = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0]
  if (!keyPem || !certPem) {
    const absent = [keyPem ? '' : 'an unencrypted private key', certPem ? '' : 'a certificate'].filter(Boolean).join(' or ')
    return fail(`M365_CERT_PEM holds no ${absent}. It must hold both, PEM: \`cat key.pem cert.pem | engine secrets set M365_CERT_PEM\`.`)
  }

  let certificate: X509Certificate
  let key: KeyObject
  try {
    certificate = new X509Certificate(certPem)
  } catch (error) {
    return fail(`The certificate in M365_CERT_PEM does not parse: ${message(error)}`)
  }
  try {
    key = createPrivateKey(keyPem)
  } catch (error) {
    return fail(`The private key in M365_CERT_PEM does not parse: ${message(error)}`)
  }
  // RS256 is what the assertion is signed with; an EC key would sign
  // something, and Entra would refuse it without saying the key type was why.
  if (key.asymmetricKeyType !== 'rsa') {
    return fail(`The private key is ${key.asymmetricKeyType ?? 'not an asymmetric key'}; the client assertion is RS256 and needs an RSA key.`)
  }
  if (!certificate.checkPrivateKey(key)) {
    return fail('The private key does not belong to the certificate, so Entra would refuse every sign-in. Use the key and the certificate that were generated together.')
  }

  const credential = { key, x5t: createHash('sha1').update(certificate.raw).digest('base64url') }
  const notAfter = new Date(certificate.validTo)
  const date = notAfter.toISOString().slice(0, 10)
  const daysLeft = Math.floor((notAfter.getTime() - now) / DAY_MS)

  if (notAfter.getTime() <= now) {
    return fail(`The certificate expired on ${date}. Entra refuses an expired certificate; generate a new pair on this box and upload the new certificate to the app registration.`)
  }
  if (daysLeft < EXPIRY_WARN_DAYS) {
    return {
      credential,
      result: {
        id: 'm365-cert',
        title: TITLES.cert,
        status: 'warn',
        detail: `The certificate expires on ${date}, in ${daysLeft} day(s). The application stops reaching Microsoft 365 the moment it does; generate a new pair on this box and upload the new certificate before then.`,
      },
    }
  }
  return {
    credential,
    result: { id: 'm365-cert', title: TITLES.cert, status: 'pass', detail: `The key matches the certificate, which expires on ${date}.` },
  }
}

// -- Entra --------------------------------------------------------------------

/**
 * A client-credentials token, exactly as the application asks for one: a JWT
 * client assertion signed with the key, carrying the certificate's thumbprint.
 * Mirrored rather than shared because the two live in different repositories
 * and the application's copy is the one that has to keep working; a test here
 * pins the shape instead.
 */
async function requestToken(
  tenantId: string,
  clientId: string,
  credential: Credential,
  fetcher: typeof fetch,
): Promise<{ result: CheckResult; token?: string }> {
  const authority = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`
  const now = Math.floor(Date.now() / 1000)
  const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const signing =
    `${b64url({ alg: 'RS256', typ: 'JWT', x5t: credential.x5t })}.` +
    b64url({ aud: authority, iss: clientId, sub: clientId, jti: randomUUID(), nbf: now, exp: now + 600 })
  const assertion = `${signing}.${sign('RSA-SHA256', Buffer.from(signing), credential.key).toString('base64url')}`

  const fail = (detail: string) => ({ result: { id: 'm365-token', title: TITLES.token, status: 'fail' as const, detail } })
  let response: Response
  try {
    response = await fetcher(authority, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        scope: 'https://graph.microsoft.com/.default',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    return fail(`login.microsoftonline.com could not be reached from this box: ${message(error)}`)
  }

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) {
    // The AADSTS code and its sentence are the useful part; the trace and
    // correlation ids Entra appends on later lines are not.
    const description = String(body['error_description'] || body['error'] || `HTTP ${response.status}`).split(/\r?\n/)[0]
    return fail(`Entra refused the sign-in: ${description}`)
  }
  const token = body['access_token']
  if (typeof token !== 'string' || !token) return fail('Entra answered without a token.')
  return {
    token,
    result: { id: 'm365-token', title: TITLES.token, status: 'pass', detail: 'Entra issued a token for the app registration.' },
  }
}

// -- Graph --------------------------------------------------------------------

async function graphGet(
  url: string,
  token: string,
  fetcher: typeof fetch,
): Promise<{ status: number; code: string; text: string; body: unknown } | { error: string }> {
  let response: Response
  try {
    response = await fetcher(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    return { error: message(error) }
  }
  const body = (await response.json().catch(() => ({}))) as { error?: { code?: string; message?: string } }
  return {
    status: response.status,
    code: body.error?.code ?? '',
    text: (body.error?.message ?? '').split(/\r?\n/)[0]!.slice(0, 200),
    body,
  }
}

function graphAnswered(answer: { status: number; code: string; text: string }): string {
  return `Graph answered ${answer.status}${answer.code ? ` ${answer.code}` : ''}${answer.text ? `: ${answer.text}` : '.'}`
}

async function checkContainers(containerTypeId: string, token: string, fetcher: typeof fetch): Promise<CheckResult> {
  const filter = encodeURIComponent(`containerTypeId eq ${containerTypeId}`)
  const answer = await graphGet(`${GRAPH}/storage/fileStorage/containers?$filter=${filter}&$top=1`, token, fetcher)
  const result = (status: CheckResult['status'], detail: string): CheckResult => ({ id: 'm365-graph', title: TITLES.graph, status, detail })
  if ('error' in answer) return result('fail', `graph.microsoft.com could not be reached from this box: ${answer.error}`)
  if (answer.status === 200) return result('pass', `Graph lists containers of type ${containerTypeId}.`)
  if (answer.status === 401 || answer.status === 403) {
    return result(
      'fail',
      `${graphAnswered(answer)} The container type is not registered in this tenant, or FileStorageContainer.Selected has no admin consent.`,
    )
  }
  return result('fail', graphAnswered(answer))
}

/*
 * The application links each person to their Microsoft account by email, and
 * reading the directory for that is `User.Read.All`. Without it files still
 * reach Microsoft, but nobody can be given access to them -- which a lawyer
 * meets as "I cannot open this in Word", long after the deploy that caused it.
 */
async function checkDirectory(token: string, fetcher: typeof fetch): Promise<CheckResult> {
  const answer = await graphGet(`${GRAPH}/users?$top=1&$select=id`, token, fetcher)
  const result = (status: CheckResult['status'], detail: string): CheckResult => ({ id: 'm365-directory', title: TITLES.directory, status, detail })
  if ('error' in answer) return result('fail', `graph.microsoft.com could not be reached from this box: ${answer.error}`)
  if (answer.status === 200) return result('pass', 'Graph reads the directory, so people can be linked by email.')
  if (answer.status === 403) {
    return result('fail', `${graphAnswered(answer)} User.Read.All has no admin consent; the application needs it to link people by email.`)
  }
  return result('fail', graphAnswered(answer))
}

/**
 * Nobody shares from Word (Ali, 2026-10-27): only the application grants
 * access to a firm's files. SharePoint Embedded's restrictive model lets only
 * a container's Owner and Manager add permissions to files, and the app makes
 * people Writer or Reader, never more -- so with it on, Share in Word, Excel
 * or the browser is refused. The default is the open model, where every
 * writer can share, so an unset container type is a fail, not a warning.
 * External sharing must be off as well.
 *
 * Read from the registration in the firm's tenant, which is what the app's
 * own credentials can see. A change to the container type reaches it within
 * Microsoft's 24 hours; until then this says "open", which is the truth.
 */
async function checkSharing(containerTypeId: string, token: string, fetcher: typeof fetch): Promise<CheckResult> {
  const answer = await graphGet(`${GRAPH}/storage/fileStorage/containerTypeRegistrations/${encodeURIComponent(containerTypeId)}?$select=settings`, token, fetcher)
  const result = (status: CheckResult['status'], detail: string): CheckResult => ({ id: 'm365-sharing', title: TITLES.sharing, status, detail })
  if ('error' in answer) return result('fail', `graph.microsoft.com could not be reached from this box: ${answer.error}`)
  if (answer.status !== 200) return result('fail', `${graphAnswered(answer)} The container type registration could not be read.`)
  const settings = (answer.body as { settings?: { isSharingRestricted?: boolean; sharingCapability?: string } }).settings ?? {}
  if (settings.isSharingRestricted !== true) {
    return result(
      'fail',
      'The container type uses the open sharing model: anyone who can edit a document can share it from Word. Set isSharingRestricted on the container type (microsoft-365-files.md §10, step 6); it reaches this tenant within 24 hours.',
    )
  }
  if (settings.sharingCapability && settings.sharingCapability !== 'disabled') {
    return result('fail', `External sharing is allowed (${settings.sharingCapability}). Set sharingCapability to disabled.`)
  }
  return result('pass', 'Only the application grants access: nobody can share from Word, and nothing is shared outside the firm.')
}

// -- the way back in ----------------------------------------------------------

/**
 * Microsoft tells the application about changes made in Word by calling it,
 * at `{publicUrl}/api/m365/notifications` (m365-change-notifications.md
 * §2.1). Without an address there are no subscriptions, and without https
 * Microsoft will not deliver -- either way edits made in Word are never seen,
 * and nothing anywhere fails loudly enough for anyone to notice.
 */
function checkAddress(publicUrl: string): { result: CheckResult; base?: string } {
  const result = (status: CheckResult['status'], detail: string): CheckResult => ({ id: 'm365-address', title: TITLES.address, status, detail })
  const raw = publicUrl.trim()
  if (!raw) {
    return {
      result: result(
        'fail',
        `No public address is set. Microsoft sends change notifications to {address}${NOTIFICATION_PATH}; set the address on the panel's Settings page.`,
      ),
    }
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { result: result('fail', `The public address '${raw}' is not a URL.`) }
  }
  if (url.protocol !== 'https:') {
    return { result: result('fail', `The public address ${raw} is not https; Microsoft delivers notifications only to https.`) }
  }
  // Trailing slashes stripped the way the renderer strips them for APP_PUBLIC_URL.
  const base = raw.replace(/\/+$/, '')
  return { base, result: result('pass', `Microsoft will call ${base}${NOTIFICATION_PATH}.`) }
}

/**
 * Microsoft's handshake, sent from this box to the public address: the same
 * request Microsoft makes when a subscription is created, answered the same
 * way -- 200, the token back, within ten seconds. Redirects are not followed,
 * because Microsoft's answer has to come from that address itself, and a
 * redirect is usually the thing in the way: Cloudflare Access sending an
 * anonymous caller to a sign-in page Microsoft cannot use.
 *
 * It asks the application that is running now, not the version being
 * deployed. That is deliberate: the runbook deploys the version with the
 * endpoint first, with no Microsoft configuration, and only then supplies it.
 */
async function checkHandshake(base: string, fetcher: typeof fetch): Promise<CheckResult> {
  const result = (status: CheckResult['status'], detail: string): CheckResult => ({
    id: 'm365-notifications',
    title: TITLES.notifications,
    status,
    detail,
  })
  const token = randomBytes(16).toString('hex')
  const target = `${base}${NOTIFICATION_PATH}`

  let response: Response
  try {
    response = await fetcher(`${target}?validationToken=${token}`, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
    })
  } catch (error) {
    return result('fail', `${target} did not answer from this box within ${HANDSHAKE_TIMEOUT_MS / 1000} s: ${message(error)}`)
  }

  if (response.status === 200) {
    const text = await response.text().catch(() => '')
    return text === token
      ? result('pass', `Microsoft's handshake gets through: ${target} answered with the token.`)
      : result('fail', `${target} answered 200 but not with the token, so something other than the application answered it.`)
  }
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location') ?? ''
    if (location.includes('cloudflareaccess.com')) {
      return result(
        'fail',
        'Cloudflare Access is in front of the notification path; run `node scripts/cloudflare/m365-notification-bypass.mjs <host>` from the app repository.',
      )
    }
    return result('fail', `${target} answered ${response.status}, a redirect to ${location || 'nowhere'}. Microsoft needs the token back from this address itself.`)
  }
  if (response.status === 404) {
    return result(
      'fail',
      `${target} answered 404: the running application has no notification endpoint. Deploy app 1.28 or later before configuring Microsoft 365.`,
    )
  }
  return result('fail', `${target} answered ${response.status}. Microsoft needs 200 with the token back.`)
}

function message(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  if (error.name === 'TimeoutError') return 'no answer in time'
  // undici says only "fetch failed"; the reason is on the cause.
  const cause = (error as { cause?: unknown }).cause
  return cause instanceof Error ? cause.message : error.message
}

// -- the apply gate -----------------------------------------------------------

export interface M365Gate {
  /** Whether the apply may go ahead. */
  readonly proceed: boolean
  /** The checks, when they were run. Absent when nothing needed checking. */
  readonly checks?: readonly CheckResult[]
  /** One line for the log; empty when Microsoft 365 is not configured. */
  readonly detail: string
  /** What to record once the apply succeeds: the fingerprint, or none. */
  readonly fingerprint: string | undefined
}

/**
 * Before an apply, from the shell or the panel.
 *
 * Only a *changed* configuration is checked. Microsoft has bad minutes like
 * anyone, and a routine version update that refused to run because Entra was
 * slow would make Microsoft's uptime the firm's deploy window -- for a
 * configuration that was proven when it was first applied and has not changed
 * since. The fingerprint is what makes "has not changed" a fact rather than a
 * guess, and it is recorded only after an apply succeeds, so a deploy that
 * failed halfway is checked again next time.
 */
export async function m365Gate(dir = stateDir(), fetcher: typeof fetch = fetch): Promise<M365Gate> {
  const secrets = loadSecrets(dir)
  const state = loadState(dir)
  const configured = m365Configured(secrets)

  if (configured === 'none') return { proceed: true, detail: '', fingerprint: undefined }
  if (configured === 'partial') {
    return {
      proceed: false,
      fingerprint: undefined,
      detail: `Microsoft 365 is only partly configured: ${missingSecrets(secrets).join(', ')} missing. Set all four or clear them all. Nothing has been touched.`,
    }
  }

  const fingerprint = m365Fingerprint(secrets, state.settings.publicUrl)
  if (fingerprint === state.m365AppliedFingerprint) {
    return { proceed: true, fingerprint, detail: 'Microsoft 365 is unchanged since it was last applied; not checked again.' }
  }

  const checks = await checkM365(dir, fetcher)
  const failed = checks.some((check) => check.status === 'fail')
  return {
    proceed: !failed,
    checks,
    fingerprint,
    detail: failed
      ? 'This Microsoft 365 configuration does not work yet. Fix the ✗ lines; nothing has been touched.'
      : 'The Microsoft 365 configuration works.',
  }
}

/** After a successful apply: remember what was applied, or that nothing was. */
export function recordM365Applied(fingerprint: string | undefined, dir = stateDir()): void {
  updateState((state) => {
    if (state.m365AppliedFingerprint === fingerprint) return state
    const { m365AppliedFingerprint: _applied, ...rest } = state
    return fingerprint ? { ...rest, m365AppliedFingerprint: fingerprint } : rest
  }, dir)
}

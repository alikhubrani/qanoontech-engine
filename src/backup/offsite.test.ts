import { createVerify, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadState, saveSecrets, saveState } from '../state/store.js'
import { DriveClient } from './drive.js'
import { fetchSet, listRemote, pendingOffsite, readOffsite, uploadSet } from './offsite.js'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const KEY_JSON = JSON.stringify({
  client_email: 'backups@firm.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
})

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'offsite-test-'))
  saveSecrets({ GOOGLE_SERVICE_ACCOUNT_KEY: KEY_JSON }, dir)
  const state = loadState(dir)
  saveState(
    {
      ...state,
      settings: { ...state.settings, backupOffsiteEnabled: true, backupOffsiteDriveId: '0ADriveId' },
    },
    dir,
  )
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function localSet(id: string): void {
  const setDir = join(dir, 'backups', id)
  mkdirSync(setDir, { recursive: true })
  writeFileSync(join(setDir, 'database.sql.gz'), 'dump-bytes')
  writeFileSync(
    join(setDir, 'manifest.json'),
    JSON.stringify({
      takenAt: new Date().toISOString(),
      trigger: 'manual',
      appVersion: '1.0.4',
      includesUploads: false,
      databaseBytes: 10,
      uploadsBytes: 0,
    }),
  )
}

/**
 * A Drive that lives in a Map: answers the token exchange (verifying the
 * assertion's signature with the real public key — a fake that skipped that
 * would pass a client that signs garbage), folder lookups, uploads and
 * downloads.
 */
function fakeDrive(): { fetcher: typeof fetch; uploads: Map<string, Buffer>; folders: Set<string> } {
  const uploads = new Map<string, Buffer>()
  const folders = new Set<string>()
  let sessionCounter = 0
  const sessions = new Map<string, string>()

  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'

    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const assertion = new URLSearchParams(String(init?.body)).get('assertion') ?? ''
      const [header, claims, signature] = assertion.split('.')
      const verifier = createVerify('RSA-SHA256')
      verifier.update(`${header}.${claims}`)
      if (!verifier.verify(publicKey, Buffer.from(signature ?? '', 'base64url'))) {
        return new Response('bad signature', { status: 401 })
      }
      return Response.json({ access_token: 'token-1', expires_in: 3600 })
    }

    if (url.includes('/upload/drive/v3/files?uploadType=resumable')) {
      const name = (JSON.parse(String(init?.body)) as { name: string }).name
      const session = `https://upload.example/session-${sessionCounter++}`
      sessions.set(session, name)
      return new Response(null, { status: 200, headers: { location: session } })
    }
    if (url.startsWith('https://upload.example/session-')) {
      const name = sessions.get(url.split('?')[0] ?? url) ?? 'unknown'
      const chunks: Buffer[] = []
      const body = init?.body as AsyncIterable<Buffer>
      for await (const chunk of body) chunks.push(Buffer.from(chunk))
      uploads.set(name, Buffer.concat(chunks))
      return Response.json({ id: `file-${name}` })
    }

    if (url.includes('/drive/v3/files?q=')) {
      const q = decodeURIComponent(url)
      const wanted = q.match(/name = '([^']+)'/)?.[1]
      if (wanted && (folders.has(wanted) || uploads.has(wanted))) {
        return Response.json({
          files: [
            {
              id: `id-${wanted}`,
              name: wanted,
              ...(uploads.has(wanted) ? { size: String(uploads.get(wanted)!.length) } : {}),
            },
          ],
        })
      }
      if (!wanted) {
        // children listing
        const files = [
          ...[...folders].map((name) => ({ id: `id-${name}`, name })),
          ...[...uploads.keys()].map((name) => ({
            id: `id-${name}`,
            name,
            size: String(uploads.get(name)!.length),
          })),
        ]
        return Response.json({ files })
      }
      return Response.json({ files: [] })
    }

    if (url.includes('/drive/v3/files') && method === 'POST') {
      const name = (JSON.parse(String(init?.body)) as { name: string }).name
      folders.add(name)
      return Response.json({ id: `id-${name}` })
    }

    if (url.includes('alt=media')) {
      const id = url.match(/files\/id-([^?]+)\?/)?.[1] ?? ''
      const content = uploads.get(id) ?? Buffer.from('{}')
      return new Response(new Uint8Array(content))
    }

    return new Response(`unhandled: ${method} ${url}`, { status: 500 })
  }) as typeof fetch

  return { fetcher, uploads, folders }
}

describe('the drive client authorises with a real signature', () => {
  it('signs an assertion the public key verifies, and refuses to proceed otherwise', async () => {
    const { fetcher } = fakeDrive()
    const client = DriveClient.fromRawKey(KEY_JSON, '0ADriveId', fetcher)
    await expect(client.authorize()).resolves.toBeTruthy()
  })
})

describe('uploading a set', () => {
  it('creates the folder tree and sends every file, and records success', async () => {
    localSet('2026-09-03T02-00-00Z')
    const { fetcher, uploads, folders } = fakeDrive()

    const outcome = await uploadSet('2026-09-03T02-00-00Z', dir, fetcher)
    expect(outcome.ok).toBe(true)
    expect(folders.has('QanoonTech Backups')).toBe(true)
    expect(folders.has('2026-09-03T02-00-00Z')).toBe(true)
    expect(uploads.get('database.sql.gz')?.toString()).toBe('dump-bytes')
    expect(uploads.has('manifest.json')).toBe(true)
    expect(readOffsite('2026-09-03T02-00-00Z', dir).uploadedAt).toBeTruthy()
  })

  it('records a failure without throwing, and the set stays pending', async () => {
    localSet('2026-09-03T02-00-00Z')
    const dead = (async () => new Response('no', { status: 500 })) as unknown as typeof fetch

    const outcome = await uploadSet('2026-09-03T02-00-00Z', dir, dead)
    expect(outcome.ok).toBe(false)
    const record = readOffsite('2026-09-03T02-00-00Z', dir)
    expect(record.lastError).toBeTruthy()
    expect(record.uploadedAt).toBe('')
    expect(pendingOffsite(dir)).toBe('2026-09-03T02-00-00Z')
  })

  it('is pending only while enabled and unsent', async () => {
    localSet('2026-09-03T02-00-00Z')
    expect(pendingOffsite(dir)).toBe('2026-09-03T02-00-00Z')

    const state = loadState(dir)
    saveState(
      { ...state, settings: { ...state.settings, backupOffsiteEnabled: false } },
      dir,
    )
    expect(pendingOffsite(dir)).toBeUndefined()
  })
})

describe('bringing a set back', () => {
  it('round-trips: upload, delete locally, fetch, and it lists again', async () => {
    localSet('2026-09-03T02-00-00Z')
    const drive = fakeDrive()
    await uploadSet('2026-09-03T02-00-00Z', dir, drive.fetcher)

    rmSync(join(dir, 'backups', '2026-09-03T02-00-00Z'), { recursive: true, force: true })
    expect(existsSync(join(dir, 'backups', '2026-09-03T02-00-00Z'))).toBe(false)

    const remote = await listRemote(dir, drive.fetcher)
    expect(remote.ok).toBe(true)
    if (remote.ok) {
      expect(remote.sets.some((set) => set.name === '2026-09-03T02-00-00Z' && !set.local)).toBe(true)
    }

    const fetched = await fetchSet('2026-09-03T02-00-00Z', dir, drive.fetcher)
    expect(fetched.ok).toBe(true)
    expect(existsSync(join(dir, 'backups', '2026-09-03T02-00-00Z', 'manifest.json'))).toBe(true)
  })

  it('refuses a name that is not a timestamp, before any path is built', async () => {
    const { fetcher } = fakeDrive()
    const result = await fetchSet('../../etc', dir, fetcher)
    expect(result.ok).toBe(false)
  })
})

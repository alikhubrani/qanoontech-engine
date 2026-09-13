import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadState, saveSecrets, saveState } from '../state/store.js'
import { fetchSet, listRemote, pendingOffsite, readOffsite, reconcileOffsite, uploadSet } from './offsite.js'

const BUCKET = 'qanoontech-backups'
const ENDPOINT = 'https://abc123.eu.r2.cloudflarestorage.com'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'offsite-test-'))
  saveSecrets({ S3_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE', S3_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG' }, dir)
  const state = loadState(dir)
  saveState(
    {
      ...state,
      settings: {
        ...state.settings,
        backupOffsiteEnabled: true,
        backupS3Endpoint: ENDPOINT,
        backupS3Bucket: BUCKET,
        backupS3Region: 'auto',
      },
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
 * A bucket that lives in a Map.
 *
 * It answers the four requests `S3Client` actually makes, in the shapes it
 * makes them: `PUT /<bucket>/<key>`, `GET /<bucket>?list-type=2&prefix=...`
 * returning `ListObjectsV2` XML, `GET /<bucket>/<key>`, and `DELETE`. The
 * listing is XML rather than something convenient because that is what the
 * client parses, and a fake that returned JSON would pass a client that cannot
 * read a real response.
 *
 * `head()` is deliberately not a case here: the client implements it as a
 * `list()` of one key, which is the whole point of that decision — Cloudflare
 * strips `content-length` from a compressed HEAD and the size reads as zero.
 * Answering HEAD here would let that bug back in unnoticed.
 */
function fakeS3(): { fetcher: typeof fetch; objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>()

  const listing = (prefix: string): string => {
    const matched = [...objects].filter(([key]) => key.startsWith(prefix))
    const contents = matched
      .map(([key, body]) => `<Contents><Key>${key}</Key><Size>${body.length}</Size></Contents>`)
      .join('')
    return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`
  }

  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    // Path-style addressing: /<bucket> is the bucket, /<bucket>/<key> an object.
    const afterBucket = url.pathname.slice(`/${BUCKET}`.length).replace(/^\//, '')

    if (method === 'GET' && url.searchParams.get('list-type') === '2') {
      return new Response(listing(url.searchParams.get('prefix') ?? ''), { status: 200 })
    }
    if (method === 'PUT') {
      objects.set(afterBucket, Buffer.from((init?.body as Uint8Array) ?? new Uint8Array()))
      return new Response('', { status: 200 })
    }
    if (method === 'GET') {
      const body = objects.get(afterBucket)
      return body
        ? new Response(new Uint8Array(body), { status: 200 })
        : new Response('NoSuchKey', { status: 404 })
    }
    if (method === 'DELETE') {
      objects.delete(afterBucket)
      return new Response('', { status: 204 })
    }
    return new Response(`unhandled: ${method} ${url}`, { status: 500 })
  }) as unknown as typeof fetch

  return { fetcher, objects }
}

describe('uploading a set', () => {
  it('sends every file under the set’s own prefix, and records success', async () => {
    localSet('2026-09-03T02-00-00Z')
    const { fetcher, objects } = fakeS3()

    const outcome = await uploadSet('2026-09-03T02-00-00Z', dir, fetcher)
    expect(outcome.ok).toBe(true)
    // Sets live under `backups/`, keeping them clear of `documents/`.
    expect(objects.get('backups/2026-09-03T02-00-00Z/database.sql.gz')?.toString()).toBe('dump-bytes')
    expect(objects.has('backups/2026-09-03T02-00-00Z/manifest.json')).toBe(true)
    expect(readOffsite('2026-09-03T02-00-00Z', dir).uploadedAt).toBeTruthy()
  })

  it('records a failure without throwing, and the set stays pending', async () => {
    localSet('2026-09-03T02-00-00Z')
    const dead = (async () => new Response('no', { status: 500 })) as unknown as typeof fetch

    const outcome = await uploadSet('2026-09-03T02-00-00Z', dir, dead, { pause: async () => {} })
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
    const store = fakeS3()
    await uploadSet('2026-09-03T02-00-00Z', dir, store.fetcher)

    rmSync(join(dir, 'backups', '2026-09-03T02-00-00Z'), { recursive: true, force: true })
    expect(existsSync(join(dir, 'backups', '2026-09-03T02-00-00Z'))).toBe(false)

    const remote = await listRemote(dir, store.fetcher)
    expect(remote.ok).toBe(true)
    if (remote.ok) {
      expect(remote.sets.some((set) => set.name === '2026-09-03T02-00-00Z' && !set.local)).toBe(true)
    }

    const fetched = await fetchSet('2026-09-03T02-00-00Z', dir, store.fetcher)
    expect(fetched.ok).toBe(true)
    expect(existsSync(join(dir, 'backups', '2026-09-03T02-00-00Z', 'manifest.json'))).toBe(true)
  })

  it('refuses a name that is not a timestamp, before any path is built', async () => {
    const { fetcher } = fakeS3()
    const result = await fetchSet('../../etc', dir, fetcher)
    expect(result.ok).toBe(false)
  })
})

/**
 * Which set goes next, and the backlog that used to be unreachable.
 *
 * This returned the newest-or-nothing, so a deployment that turned offsite on
 * — or had it fail for a fortnight — copied only what it took from that moment
 * and left every earlier set on the box for ever. Staging had fourteen such
 * sets when offsite was first switched to R2, and thirteen of them were never
 * going to be copied anywhere.
 */
describe('choosing what to send offsite', () => {
  const makeSet = (dir: string, id: string, uploaded: boolean) => {
    mkdirSync(join(dir, 'backups', id), { recursive: true })
    writeFileSync(
      join(dir, 'backups', id, 'manifest.json'),
      JSON.stringify({
        takenAt: `${id.slice(0, 10)}T${id.slice(11, 19).replaceAll('-', ':')}.000Z`,
        trigger: 'scheduled',
        appVersion: '1.0.0',
        includesUploads: false,
        databaseBytes: 1,
        uploadsBytes: 0,
      }),
    )
    if (uploaded) {
      writeFileSync(
        join(dir, 'backups', id, 'offsite.json'),
        JSON.stringify({ uploadedAt: '2026-09-12T00:00:00.000Z', attempts: 1, lastError: '' }),
      )
    }
  }

  const enableOffsite = (dir: string) => {
    const state = loadState(dir)
    saveState(
      { ...state, settings: { ...state.settings, backupOffsiteEnabled: true } },
      dir,
    )
  }

  it('sends the newest first — one upload should buy the most recent copy', () => {
    enableOffsite(dir)
    makeSet(dir, '2026-09-01T10-00-00Z', false)
    makeSet(dir, '2026-09-12T10-00-00Z', false)
    expect(pendingOffsite(dir)).toBe('2026-09-12T10-00-00Z')
  })

  it('then drains the backlog oldest-first', () => {
    enableOffsite(dir)
    makeSet(dir, '2026-09-01T10-00-00Z', false)
    makeSet(dir, '2026-09-05T10-00-00Z', false)
    makeSet(dir, '2026-09-12T10-00-00Z', true)
    expect(pendingOffsite(dir)).toBe('2026-09-01T10-00-00Z')
  })

  it('is finished when everything has gone', () => {
    enableOffsite(dir)
    makeSet(dir, '2026-09-01T10-00-00Z', true)
    makeSet(dir, '2026-09-12T10-00-00Z', true)
    expect(pendingOffsite(dir)).toBeUndefined()
  })

  it('sends nothing while offsite is off', () => {
    // The suite's beforeEach turns offsite on for every other test here.
    const state = loadState(dir)
    saveState({ ...state, settings: { ...state.settings, backupOffsiteEnabled: false } }, dir)
    makeSet(dir, '2026-09-12T10-00-00Z', false)
    expect(pendingOffsite(dir)).toBeUndefined()
  })
})

/**
 * A record that says a copy exists is worth nothing if the object was removed.
 *
 * Four sets were deleted from a real bucket during testing; every local record
 * still said `uploadedAt`, so nothing would ever have offered them again and
 * the deployment reported itself safe while four of its copies did not exist.
 */
describe('reconciling what we believe against what is there', () => {
  const markSent = (id: string) =>
    writeFileSync(
      join(dir, 'backups', id, 'offsite.json'),
      JSON.stringify({ uploadedAt: '2026-09-12T09:00:00.000Z', attempts: 1, lastError: '' }),
    )

  it('clears a claim the store cannot support, so the set goes again', async () => {
    localSet('2026-09-03T02-00-00Z')
    const store = fakeS3()
    await uploadSet('2026-09-03T02-00-00Z', dir, store.fetcher)
    expect(readOffsite('2026-09-03T02-00-00Z', dir).uploadedAt).not.toBe('')

    // The objects go away behind the engine's back.
    store.objects.clear()

    const result = await reconcileOffsite(dir, store.fetcher)
    expect(result.corrected).toEqual(['2026-09-03T02-00-00Z'])
    expect(readOffsite('2026-09-03T02-00-00Z', dir).uploadedAt).toBe('')
    expect(pendingOffsite(dir)).toBe('2026-09-03T02-00-00Z')
  })

  it('leaves a claim alone when the store agrees', async () => {
    localSet('2026-09-03T02-00-00Z')
    const store = fakeS3()
    await uploadSet('2026-09-03T02-00-00Z', dir, store.fetcher)
    const before = readOffsite('2026-09-03T02-00-00Z', dir).uploadedAt
    const result = await reconcileOffsite(dir, store.fetcher)
    expect(result.corrected).toEqual([])
    expect(readOffsite('2026-09-03T02-00-00Z', dir).uploadedAt).toBe(before)
  })

  /*
   * The one that matters most. "I could not see it" must never be recorded as
   * "it is not there" -- an outage would otherwise mark the whole archive for
   * re-upload the moment the connection came back.
   */
  it('changes nothing when the store cannot be reached', async () => {
    localSet('2026-09-03T02-00-00Z')
    markSent('2026-09-03T02-00-00Z')
    const broken = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    const result = await reconcileOffsite(dir, broken, { pause: async () => {} })
    expect(result.corrected).toEqual([])
    expect(readOffsite('2026-09-03T02-00-00Z', dir).uploadedAt).not.toBe('')
  })

  it('does nothing while offsite is off', async () => {
    const state = loadState(dir)
    saveState({ ...state, settings: { ...state.settings, backupOffsiteEnabled: false } }, dir)
    localSet('2026-09-03T02-00-00Z')
    markSent('2026-09-03T02-00-00Z')
    expect((await reconcileOffsite(dir)).corrected).toEqual([])
  })
})

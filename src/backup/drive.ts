import { createSign } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'

/**
 * A minimal Google Drive client for the offsite backup copy.
 *
 * Deliberately dependency-free: service-account auth is one RS256-signed JWT
 * exchanged for a token, and Drive is plain HTTPS. The box talks to Google
 * directly — nothing goes through any vendor system, and the drive belongs to
 * the firm.
 *
 * Every call passes supportsAllDrives: a Shared Drive is invisible to the API
 * without it, and the resulting 404 reads like a missing file.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const DRIVE = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
const SCOPE = 'https://www.googleapis.com/auth/drive'
const FOLDER_MIME = 'application/vnd.google-apps.folder'

interface ServiceAccountKey {
  client_email: string
  private_key: string
}

export function parseServiceAccountKey(raw: string): ServiceAccountKey {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('The service account key is not valid JSON. Paste the whole key file.')
  }
  const key = parsed as Partial<ServiceAccountKey>
  if (!key.client_email || !key.private_key) {
    throw new Error('The service account key is missing client_email or private_key.')
  }
  return key as ServiceAccountKey
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

export class DriveClient {
  private token: string | undefined
  private tokenExpiresAt = 0

  constructor(
    private readonly key: ServiceAccountKey,
    readonly sharedDriveId: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  static fromRawKey(raw: string, sharedDriveId: string, fetcher: typeof fetch = fetch): DriveClient {
    return new DriveClient(parseServiceAccountKey(raw), sharedDriveId, fetcher)
  }

  /** Exchange a signed assertion for an access token. Cached until near expiry. */
  async authorize(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token

    const now = Math.floor(Date.now() / 1000)
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    const claims = base64url(
      JSON.stringify({
        iss: this.key.client_email,
        scope: SCOPE,
        aud: TOKEN_URL,
        iat: now,
        exp: now + 3600,
      }),
    )
    const signer = createSign('RSA-SHA256')
    signer.update(`${header}.${claims}`)
    const signature = base64url(signer.sign(this.key.private_key))

    const response = await this.fetcher(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${header}.${claims}.${signature}`,
      }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) {
      throw new Error(`Google refused the credential (${response.status}). Is the key still valid?`)
    }
    const body = (await response.json()) as { access_token?: string; expires_in?: number }
    if (!body.access_token) throw new Error('Google answered without a token.')
    this.token = body.access_token
    this.tokenExpiresAt = Date.now() + (body.expires_in ?? 3600) * 1000
    return this.token
  }

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.authorize()
    const joiner = path.includes('?') ? '&' : '?'
    const response = await this.fetcher(
      `${path}${joiner}supportsAllDrives=true`,
      {
        ...init,
        headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(120_000),
      },
    )
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300)
      throw new Error(`Drive answered ${response.status}: ${detail}`)
    }
    return response
  }

  /** Find a child by exact name, or undefined. */
  async findChild(name: string, parentId: string): Promise<{ id: string; size?: string } | undefined> {
    const q = encodeURIComponent(
      `name = '${name.replaceAll("'", "\\'")}' and '${parentId}' in parents and trashed = false`,
    )
    const response = await this.call(
      `${DRIVE}/files?q=${q}&fields=files(id,size)&includeItemsFromAllDrives=true&corpora=drive&driveId=${this.sharedDriveId}`,
    )
    const body = (await response.json()) as { files?: { id: string; size?: string }[] }
    return body.files?.[0]
  }

  async ensureFolder(name: string, parentId: string): Promise<string> {
    const existing = await this.findChild(name, parentId)
    if (existing) return existing.id
    const response = await this.call(`${DRIVE}/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    })
    return ((await response.json()) as { id: string }).id
  }

  /** List a folder's children: name, id, size. */
  async listChildren(parentId: string): Promise<{ id: string; name: string; size?: string }[]> {
    const q = encodeURIComponent(`'${parentId}' in parents and trashed = false`)
    const response = await this.call(
      `${DRIVE}/files?q=${q}&fields=files(id,name,size)&pageSize=1000&includeItemsFromAllDrives=true&corpora=drive&driveId=${this.sharedDriveId}`,
    )
    return ((await response.json()) as { files?: { id: string; name: string; size?: string }[] }).files ?? []
  }

  /**
   * Upload a file from disk, resumable, streamed — a database dump can be
   * gigabytes and must not transit through this process's memory.
   */
  async uploadFile(name: string, parentId: string, filePath: string, mimeType: string): Promise<string> {
    const size = statSync(filePath).size
    const start = await this.call(`${UPLOAD}/files?uploadType=resumable`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, parents: [parentId] }),
    })
    const session = start.headers.get('location')
    if (!session) throw new Error('Drive did not open an upload session.')

    const token = await this.authorize()
    const put = await this.fetcher(session, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': mimeType,
        'content-length': String(size),
      },
      // node's fetch accepts a stream body when duplex is set; the option is
      // absent from the lib types, hence the cast.
      body: createReadStream(filePath) as unknown as NonNullable<RequestInit['body']>,
      duplex: 'half',
      signal: AbortSignal.timeout(60 * 60_000),
    })
    if (!put.ok) {
      throw new Error(`Drive upload failed (${put.status}) after ${size} bytes were offered.`)
    }
    return ((await put.json()) as { id: string }).id
  }

  /** Stream a file down to disk. */
  async downloadFile(fileId: string, toPath: string): Promise<void> {
    const response = await this.call(`${DRIVE}/files/${fileId}?alt=media`)
    const { createWriteStream } = await import('node:fs')
    const { Readable } = await import('node:stream')
    const { pipeline } = await import('node:stream/promises')
    if (!response.body) throw new Error('Drive answered with no body.')
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(toPath))
  }
}

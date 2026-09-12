import { loadSecrets, loadState, stateDir } from '../state/store.js'
import { S3Client } from './s3.js'

/**
 * Where the offsite copy goes.
 *
 * This interface was introduced when there were two destinations — a firm's
 * Google Shared Drive and object storage — and it is the object-storage shape
 * because that was the smaller of the two: a key, some bytes, a size. Drive
 * has since been retired, so today there is one implementation. The seam is
 * kept because it is what let the second destination arrive without a second
 * copy of `offsite.ts`, and the same would be true of a third.
 *
 * Everything is addressed by key, `<set id>/<file name>`, under a root the
 * provider decides. A firm recovering onto a new machine brings a set back by
 * that name, so the name is the identity and renaming it remotely is the one
 * way to break the way home.
 */

export interface OffsiteObject {
  readonly key: string
  readonly size: number
}

export interface OffsiteStore {
  /** What to call it on a screen: "Cloudflare R2". */
  readonly label: string
  put(key: string, filePath: string, contentType: string): Promise<void>
  /** The object, or undefined when it is not there. Used to skip a re-upload. */
  stat(key: string): Promise<OffsiteObject | undefined>
  list(prefix: string): Promise<OffsiteObject[]>
  get(key: string, toPath: string): Promise<void>
  /** Used by the connectivity probe, which must not leave litter behind. */
  remove(key: string): Promise<void>
}

/** Object storage, which is already the shape. */
class S3Store implements OffsiteStore {
  readonly label: string

  constructor(
    private readonly client: S3Client,
    private readonly prefix: string,
    label = 'Cloudflare R2',
  ) {
    this.label = label
  }

  private at(key: string): string {
    return `${this.prefix}${key}`
  }

  put(key: string, filePath: string, contentType: string): Promise<void> {
    return this.client.putFile(this.at(key), filePath, contentType)
  }

  async stat(key: string): Promise<OffsiteObject | undefined> {
    const found = await this.client.head(this.at(key))
    return found ? { key, size: found.size } : undefined
  }

  async list(prefix: string): Promise<OffsiteObject[]> {
    const objects = await this.client.list(this.at(prefix))
    return objects.map((object) => ({ key: object.key.slice(this.prefix.length), size: object.size }))
  }

  get(key: string, toPath: string): Promise<void> {
    return this.client.getFile(this.at(key), toPath)
  }

  remove(key: string): Promise<void> {
    return this.client.deleteObject(this.at(key))
  }
}

/**
 * A store from credentials supplied right now, rather than from stored state.
 *
 * Recovery is the case this exists for: a bare machine has no settings and no
 * secrets — that is what it is recovering — so the endpoint, bucket and keys
 * are typed by whoever is holding the terminal. Everything after the first
 * fetch comes from the snapshot itself.
 */
export function s3StoreFrom(
  config: {
    endpoint: string
    bucket: string
    region?: string
    accessKeyId: string
    secretAccessKey: string
    prefix?: string
  },
  fetcher: typeof fetch = fetch,
): OffsiteStore {
  const client = S3Client.from(
    {
      endpoint: config.endpoint,
      bucket: config.bucket,
      region: config.region ?? 'auto',
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    fetcher,
  )
  const prefix = config.prefix ? `${config.prefix.replace(/^\/+|\/+$/g, '')}/` : ''
  return new S3Store(client, prefix)
}

/**
 * The configured store, or null with the reason a panel should show.
 *
 * Never throws: every caller is a tick or a just-finished backup, and neither
 * may die because a firm has half-filled a settings form.
 */
export function offsiteStore(
  dir = stateDir(),
  fetcher: typeof fetch = fetch,
): { store: OffsiteStore | null; reason?: string } {
  const settings = loadState(dir).settings
  if (!settings.backupOffsiteEnabled) return { store: null, reason: 'off' }
  const secrets = loadSecrets(dir)

  try {
    const client = S3Client.from(
      {
        endpoint: settings.backupS3Endpoint,
        bucket: settings.backupS3Bucket,
        region: settings.backupS3Region,
        accessKeyId: secrets['S3_ACCESS_KEY_ID'] ?? '',
        secretAccessKey: secrets['S3_SECRET_ACCESS_KEY'] ?? '',
      },
      fetcher,
    )
    const prefix = settings.backupS3Prefix
      ? `${settings.backupS3Prefix.replace(/^\/+|\/+$/g, '')}/`
      : ''
    return { store: new S3Store(client, prefix) }
  } catch (error) {
    return { store: null, reason: (error as Error).message }
  }
}

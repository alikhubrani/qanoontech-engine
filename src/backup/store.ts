import { loadSecrets, loadState, stateDir } from '../state/store.js'
import { DriveClient } from './drive.js'
import { S3Client } from './s3.js'

/**
 * Where the offsite copy goes — one shape, two places it can be.
 *
 * `offsite.ts` was written against Drive and spoke its language: folders,
 * parent ids, `ensureFolder`. Object storage has no folders, only keys with
 * slashes in them, so adding R2 meant either a second copy of the offsite
 * logic or one interface both can satisfy. This is the interface, and it is
 * the object-storage shape because that is the smaller one: a key, some bytes,
 * a size. The Drive adapter is what does the work of pretending, walking the
 * key's segments into folders, because Drive is the odd one out.
 *
 * Everything is addressed by key, `<set id>/<file name>`, under a root the
 * provider decides. A firm recovering onto a new machine brings a set back by
 * that name, so the name is the identity in both places and renaming it
 * remotely is the one way to break the way home.
 */

export interface OffsiteObject {
  readonly key: string
  readonly size: number
}

export interface OffsiteStore {
  /** What to call it on a screen: "Google Drive", "Cloudflare R2". */
  readonly label: string
  put(key: string, filePath: string, contentType: string): Promise<void>
  /** The object, or undefined when it is not there. Used to skip a re-upload. */
  stat(key: string): Promise<OffsiteObject | undefined>
  list(prefix: string): Promise<OffsiteObject[]>
  get(key: string, toPath: string): Promise<void>
  /** Used by the connectivity probe, which must not leave litter behind. */
  remove(key: string): Promise<void>
}

const ROOT_FOLDER = 'QanoonTech Backups'

/**
 * Drive, wearing the object-storage shape.
 *
 * Folder ids are cached for the life of the store because a set is several
 * files and each would otherwise re-walk the tree — three round trips per file
 * to Google to learn something that cannot have changed since the last one.
 */
class DriveStore implements OffsiteStore {
  readonly label = 'Google Drive'
  private readonly folders = new Map<string, Promise<string>>()

  constructor(private readonly client: DriveClient) {}

  /**
   * Drive's root folder is already called "QanoonTech Backups", so a `backups/`
   * folder inside it would say the same word twice and push every existing set
   * one level deeper for nothing.
   *
   * The keys are the shared namespace and each store renders them the way its
   * own world is shaped: object storage has no folders and needs the prefix to
   * keep sets and documents apart, Drive has a named root that already does
   * that job. Stripping it here is the adapter translating, not a special case
   * — and it means the sets already in a firm's Drive stay exactly where they
   * are.
   */
  private native(key: string): string {
    return key.startsWith('backups/') ? key.slice('backups/'.length) : key
  }

  private root(): Promise<string> {
    return this.folder(ROOT_FOLDER, this.client.sharedDriveId)
  }

  private folder(name: string, parent: string): Promise<string> {
    const cacheKey = `${parent}/${name}`
    const existing = this.folders.get(cacheKey)
    if (existing) return existing
    const created = this.client.ensureFolder(name, parent)
    this.folders.set(cacheKey, created)
    return created
  }

  /** `a/b/c.gz` becomes folders a, b and the file c.gz. */
  private async resolve(key: string, create: boolean): Promise<{ parent: string; name: string } | undefined> {
    const parts = key.split('/')
    const name = parts.pop()!
    let parent = await this.root()
    for (const segment of parts) {
      if (create) {
        parent = await this.folder(segment, parent)
      } else {
        const found = await this.client.findChild(segment, parent)
        if (!found) return undefined
        parent = found.id
      }
    }
    return { parent, name }
  }

  async put(key: string, filePath: string, contentType: string): Promise<void> {
    const at = await this.resolve(this.native(key), true)
    await this.client.uploadFile(at!.name, at!.parent, filePath, contentType)
  }

  async stat(key: string): Promise<OffsiteObject | undefined> {
    const at = await this.resolve(this.native(key), false)
    if (!at) return undefined
    const found = await this.client.findChild(at.name, at.parent)
    return found ? { key, size: Number(found.size ?? 0) } : undefined
  }

  async list(prefix: string): Promise<OffsiteObject[]> {
    const asked = this.native(prefix)
    const back = (key: string) => (prefix === asked ? key : `backups/${key}`)
    // Prefixes here are '' (everything), 'backups/' (every set) or one set.
    const trimmed = asked.replace(/\/$/, '')
    const objects: OffsiteObject[] = []
    if (trimmed === '') {
      for (const folder of await this.client.listChildren(await this.root())) {
        for (const file of await this.client.listChildren(folder.id)) {
          objects.push({ key: back(`${folder.name}/${file.name}`), size: Number(file.size ?? 0) })
        }
      }
      return objects
    }
    const found = await this.client.findChild(trimmed, await this.root())
    if (!found) return []
    for (const file of await this.client.listChildren(found.id)) {
      objects.push({ key: back(`${trimmed}/${file.name}`), size: Number(file.size ?? 0) })
    }
    return objects
  }

  async get(key: string, toPath: string): Promise<void> {
    const at = await this.resolve(this.native(key), false)
    if (!at) throw new Error(`${key} is not in Drive.`)
    const found = await this.client.findChild(at.name, at.parent)
    if (!found) throw new Error(`${key} is not in Drive.`)
    await this.client.downloadFile(found.id, toPath)
  }

  async remove(key: string): Promise<void> {
    const at = await this.resolve(this.native(key), false)
    if (!at) return
    const found = await this.client.findChild(at.name, at.parent)
    if (found) await this.client.deleteFile(found.id)
  }
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

  if (settings.backupOffsiteProvider === 's3') {
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

  if (!settings.backupOffsiteDriveId) {
    return { store: null, reason: 'No Shared Drive ID is set.' }
  }
  const key = secrets['GOOGLE_SERVICE_ACCOUNT_KEY']
  if (!key) {
    return {
      store: null,
      reason:
        'No service account key is stored. Enter it under the Drive mirror module — the same key serves both.',
    }
  }
  try {
    return { store: new DriveStore(DriveClient.fromRawKey(key, settings.backupOffsiteDriveId, fetcher)) }
  } catch (error) {
    return { store: null, reason: (error as Error).message }
  }
}

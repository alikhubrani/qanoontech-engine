import { request } from 'node:http'
import type { RegistryAuth } from '../registry.js'

/**
 * Resilient image pulls with real progress and stall recovery.
 *
 * The rest of the engine shells out to `docker` for auditability, and this is
 * the one deliberate exception: it streams the Docker daemon's own pull events
 * over the mounted socket, because that JSON stream carries exact per-layer
 * byte counts — and without those, two things this deployment needs are
 * impossible. A progress bar per image, and, more importantly, telling a
 * *stall* apart from *slow*: on a firm's flaky connection a large layer's
 * download freezes without erroring, and a scrolling log makes a frozen pull
 * look identical to a working one. Bytes-not-moving is the only honest signal,
 * and only the API gives it.
 *
 * It still runs no exec, reads no data, and creates no container — it asks the
 * daemon to fetch an image, which `docker pull` does too.
 */

const SOCKET = process.env['DOCKER_SOCKET'] ?? '/var/run/docker.sock'

export type PullState = 'waiting' | 'downloading' | 'extracting' | 'stalled' | 'done' | 'failed'

export interface ImageProgress {
  readonly image: string
  state: PullState
  /** Bytes pulled and the total where the daemon has reported one. */
  downloaded: number
  total: number
  /** 0–100, or -1 before any total is known. */
  percent: number
  /** Which retry we are on; 1 on the first attempt. */
  attempt: number
  detail: string
}

interface DaemonEvent {
  status?: string
  id?: string
  progressDetail?: { current?: number; total?: number }
  error?: string
}

/** Registry auth as the daemon's X-Registry-Auth header wants it. */
function registryAuthHeader(auth: RegistryAuth | undefined): string | undefined {
  if (!auth) return undefined
  const payload = JSON.stringify({
    username: auth.username,
    password: auth.token,
    serveraddress: 'ghcr.io',
  })
  return Buffer.from(payload).toString('base64url')
}

/**
 * Aggregate the daemon's per-layer events into one image's progress.
 *
 * Pulled out as a pure reducer so the interesting behaviour — how bytes add up
 * across layers, when a total is known, what counts as "extracting" — is
 * testable without a daemon.
 */
export class ImagePullTracker {
  private readonly layers = new Map<string, { current: number; total: number; done: boolean }>()

  apply(event: DaemonEvent): void {
    if (!event.id) return
    const layer = this.layers.get(event.id) ?? { current: 0, total: 0, done: false }
    const status = event.status ?? ''

    if (event.progressDetail?.total) layer.total = event.progressDetail.total
    if (event.progressDetail?.current !== undefined) layer.current = event.progressDetail.current
    if (status === 'Download complete' || status === 'Pull complete' || status === 'Already exists') {
      layer.done = true
      if (layer.total > 0) layer.current = layer.total
    }
    this.layers.set(event.id, layer)
  }

  /** Total bytes across layers that have reported a size. */
  downloaded(): number {
    let sum = 0
    for (const layer of this.layers.values()) sum += layer.current
    return sum
  }

  total(): number {
    let sum = 0
    for (const layer of this.layers.values()) sum += layer.total
    return sum
  }

  extracting(): boolean {
    // Every sized layer downloaded, but the daemon is still unpacking.
    const sized = [...this.layers.values()].filter((l) => l.total > 0)
    return sized.length > 0 && sized.every((l) => l.current >= l.total)
  }
}

export interface PullOptions {
  readonly auth?: RegistryAuth
  readonly onProgress?: (progress: ImageProgress) => void
  /** No byte movement for this long ⇒ stalled; abort and retry. */
  readonly stallMs?: number
  readonly maxAttempts?: number
  readonly fetchSocket?: string
}

/**
 * Pull one image, resuming through stalls. Each attempt hands the daemon the
 * same request; containerd keeps the partial blobs, so a retry continues from
 * where the last one froze rather than starting the layer again.
 */
export function pullImage(image: string, options: PullOptions = {}): Promise<ImageProgress> {
  const stallMs = options.stallMs ?? 45_000
  const maxAttempts = options.maxAttempts ?? 6
  const progress: ImageProgress = {
    image,
    state: 'waiting',
    downloaded: 0,
    total: 0,
    percent: -1,
    attempt: 0,
    detail: '',
  }

  const emit = () => options.onProgress?.({ ...progress })

  const attempt = (n: number): Promise<ImageProgress> =>
    new Promise((resolve) => {
      progress.attempt = n
      progress.state = 'downloading'
      const tracker = new ImagePullTracker()
      let lastBytes = -1
      let lastMovedAt = Date.now()
      let settled = false

      const [repo, tag] = splitImage(image)
      const headers: Record<string, string> = {}
      const authHeader = registryAuthHeader(options.auth)
      if (authHeader) headers['X-Registry-Auth'] = authHeader

      const req = request(
        {
          socketPath: options.fetchSocket ?? SOCKET,
          path: `/images/create?fromImage=${encodeURIComponent(repo)}&tag=${encodeURIComponent(tag)}`,
          method: 'POST',
          headers,
        },
        (res) => {
          let buffer = ''
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => {
            buffer += chunk
            let index: number
            while ((index = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, index).trim()
              buffer = buffer.slice(index + 1)
              if (!line) continue
              let event: DaemonEvent
              try {
                event = JSON.parse(line) as DaemonEvent
              } catch {
                continue
              }
              if (event.error) {
                progress.detail = event.error
                continue
              }
              tracker.apply(event)
              progress.downloaded = tracker.downloaded()
              progress.total = tracker.total()
              progress.percent =
                progress.total > 0 ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100)) : -1
              progress.state = tracker.extracting() ? 'extracting' : 'downloading'
              if (progress.downloaded > lastBytes) {
                lastBytes = progress.downloaded
                lastMovedAt = Date.now()
              }
              emit()
            }
          })
          res.on('end', () => finish(progress.detail ? 'failed' : 'done'))
          res.on('error', () => finish('failed'))
        },
      )

      // The stall watchdog: if bytes have not moved in stallMs, tear the
      // request down so the next attempt can resume.
      const watchdog = setInterval(() => {
        if (progress.state === 'extracting') return // unpack reports no bytes
        if (Date.now() - lastMovedAt > stallMs) {
          progress.state = 'stalled'
          emit()
          req.destroy()
          finish('failed')
        }
      }, 5_000)

      const finish = (state: PullState) => {
        if (settled) return
        settled = true
        clearInterval(watchdog)
        if (state === 'done') {
          progress.state = 'done'
          progress.percent = 100
          emit()
          resolve(progress)
        } else {
          if (n < maxAttempts) {
            const backoff = Math.min(2000 * 2 ** (n - 1), 30_000)
            progress.detail = `retrying (attempt ${n + 1})`
            emit()
            setTimeout(() => attempt(n + 1).then(resolve), backoff)
          } else {
            progress.state = 'failed'
            progress.detail = progress.detail || 'gave up after repeated stalls'
            emit()
            resolve(progress)
          }
        }
      }

      req.on('error', () => finish('failed'))
      req.end()
    })

  emit()
  return attempt(1)
}

/** Pull images one at a time — kinder to a weak link than three at once. */
export async function pullImages(
  images: readonly string[],
  options: PullOptions = {},
): Promise<{ ok: boolean; images: ImageProgress[] }> {
  const results: ImageProgress[] = []
  for (const image of images) {
    const result = await pullImage(image, options)
    results.push(result)
    if (result.state === 'failed') return { ok: false, images: results }
  }
  return { ok: true, images: results }
}

function splitImage(image: string): [string, string] {
  // Split the tag off, but not a registry-host port colon.
  const slash = image.lastIndexOf('/')
  const colon = image.lastIndexOf(':')
  if (colon > slash) return [image.slice(0, colon), image.slice(colon + 1)]
  return [image, 'latest']
}

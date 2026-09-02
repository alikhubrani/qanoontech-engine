import { loadSecrets, stateDir } from './state/store.js'

/**
 * The GHCR client: which versions exist, and does the credential work.
 *
 * Speaks the OCI distribution API directly rather than shelling out, for one
 * reason worth having: failures get names. `docker pull` reduces every
 * credential problem to `manifest unknown` four steps after the mistake; a
 * direct 401 on the token endpoint says "the token is wrong" at the moment
 * it can still be retyped. This is the diagnosis point — pulls themselves
 * still go through docker, which holds the same credential via `login`.
 */

export const REGISTRY = 'ghcr.io'
export const IMAGE_REPOSITORY = 'alikhubrani/qanoontech'

export interface RegistryAuth {
  readonly username: string
  readonly token: string
}

export function storedRegistryAuth(dir = stateDir()): RegistryAuth | undefined {
  const secrets = loadSecrets(dir)
  const username = secrets['GHCR_USERNAME']
  const token = secrets['GHCR_TOKEN']
  return username && token ? { username, token } : undefined
}

export interface RegistryProbe {
  readonly ok: boolean
  readonly detail: string
  /** Server time from the response, for the clock-skew check. */
  readonly serverDate?: number
}

async function bearerToken(
  auth: RegistryAuth,
  repository: string,
  fetcher: typeof fetch,
): Promise<{ token?: string; probe: RegistryProbe }> {
  const url =
    `https://${REGISTRY}/token?service=${REGISTRY}` +
    `&scope=repository:${repository}:pull`
  let response: Response
  try {
    response = await fetcher(url, {
      headers: {
        authorization: `Basic ${Buffer.from(`${auth.username}:${auth.token}`).toString('base64')}`,
      },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    return {
      probe: {
        ok: false,
        detail: `Could not reach ${REGISTRY}: ${error instanceof Error ? error.message : String(error)}`,
      },
    }
  }

  const serverDateHeader = response.headers.get('date')
  const serverDate = serverDateHeader ? Date.parse(serverDateHeader) : undefined
  const dated = serverDate !== undefined && !Number.isNaN(serverDate) ? { serverDate } : {}

  if (response.status === 401 || response.status === 403) {
    return {
      probe: {
        ok: false,
        detail: 'The registry refused the credential. Check the username and that the token has read:packages.',
        ...dated,
      },
    }
  }
  if (!response.ok) {
    return { probe: { ok: false, detail: `${REGISTRY} answered ${response.status}.`, ...dated } }
  }

  const body = (await response.json().catch(() => ({}))) as { token?: string }
  if (!body.token) {
    return { probe: { ok: false, detail: 'The registry answered without a token.', ...dated } }
  }
  return { token: body.token, probe: { ok: true, detail: 'Credential accepted.', ...dated } }
}

/** Can this credential actually pull the application image? */
export async function probeRegistry(
  auth: RegistryAuth,
  fetcher: typeof fetch = fetch,
): Promise<RegistryProbe> {
  const { token, probe } = await bearerToken(auth, IMAGE_REPOSITORY, fetcher)
  if (!token) return probe

  // The token endpoint hands tokens to anyone; only the manifest proves the
  // credential can read this repository.
  try {
    const response = await fetcher(
      `https://${REGISTRY}/v2/${IMAGE_REPOSITORY}/manifests/latest`,
      {
        method: 'HEAD',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json',
        },
        signal: AbortSignal.timeout(15_000),
      },
    )
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      return {
        ok: false,
        detail: 'The credential is real but cannot read the application image. It may be for the wrong account, or lack read:packages.',
        ...(probe.serverDate !== undefined ? { serverDate: probe.serverDate } : {}),
      }
    }
    if (!response.ok) {
      return { ok: false, detail: `The registry answered ${response.status} for the image.` }
    }
  } catch (error) {
    return {
      ok: false,
      detail: `Could not check the image: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  return probe
}

/**
 * Published versions, newest first by semantic order. Prereleases and the
 * moving tags (latest, staging, 1.4) are listed after releases; sha tags are
 * dropped — nobody installs a commit by hand from a version picker.
 */
export async function listVersions(
  auth: RegistryAuth,
  fetcher: typeof fetch = fetch,
): Promise<{ ok: true; versions: string[] } | { ok: false; detail: string }> {
  const { token, probe } = await bearerToken(auth, IMAGE_REPOSITORY, fetcher)
  if (!token) return { ok: false, detail: probe.detail }

  const tags: string[] = []
  let url: string | undefined = `https://${REGISTRY}/v2/${IMAGE_REPOSITORY}/tags/list?n=100`
  try {
    while (url !== undefined) {
      const response: Response = await fetcher(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) return { ok: false, detail: `${REGISTRY} answered ${response.status}.` }
      const body = (await response.json()) as { tags?: string[] }
      tags.push(...(body.tags ?? []))
      url = nextPage(response.headers.get('link'))
    }
  } catch (error) {
    return {
      ok: false,
      detail: `Could not list versions: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  return { ok: true, versions: orderVersions(tags) }
}

function nextPage(link: string | null): string | undefined {
  const match = link?.match(/<([^>]+)>;\s*rel="next"/)
  if (!match?.[1]) return undefined
  return match[1].startsWith('http') ? match[1] : `https://${REGISTRY}${match[1]}`
}

const RELEASE = /^\d+\.\d+\.\d+$/
const PRERELEASE = /^\d+\.\d+\.\d+-/

export function orderVersions(tags: readonly string[]): string[] {
  const releases = tags.filter((t) => RELEASE.test(t)).sort(compareSemver).reverse()
  const prereleases = tags.filter((t) => PRERELEASE.test(t)).sort(compareSemver).reverse()
  const moving = tags.filter((t) => ['latest', 'staging'].includes(t)).sort()
  return [...releases, ...prereleases, ...moving]
}

function compareSemver(a: string, b: string): number {
  const parse = (v: string) => v.split('-')[0]!.split('.').map(Number)
  const [aParts, bParts] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) {
    const difference = (aParts[i] ?? 0) - (bParts[i] ?? 0)
    if (difference !== 0) return difference
  }
  // Same numeric core: a release outranks its own prereleases.
  return (a.includes('-') ? 0 : 1) - (b.includes('-') ? 0 : 1)
}

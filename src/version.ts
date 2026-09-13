import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The engine's own version: the tag baked into the image, else its package. */
export function engineVersion(): string {
  // The image bakes the release tag in; package.json is the fallback for a
  // checkout run by hand and is the number that once lagged behind the tag.
  // This file compiles to dist/version.js, so the package is one level up;
  // the second path covers a checkout run from src/ through a loader.
  const baked = process.env.ENGINE_VERSION?.trim()
  if (baked && baked !== 'dev') return baked
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    for (const relative of ['../package.json', '../../package.json']) {
      const path = join(here, relative)
      if (existsSync(path)) {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: string }
        if (parsed.version) return parsed.version
      }
    }
  } catch {
    /* fall through */
  }
  return 'dev'
}

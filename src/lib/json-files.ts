import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Read a JSON file. Absent is undefined; corrupt is an error unless the caller
 * says otherwise.
 *
 * The default is deliberate. A corrupt state file read as "empty" is an engine
 * that wakes up believing the deployment is nothing and offers to make it so;
 * a corrupt credentials file read as "no password" is a setup screen anyone
 * can use. Both must fail loudly instead. Only files that are regenerable and
 * carry no authority — sessions, the throttle — may pass `lenient`, where the
 * cost of dropping them is a sign-in.
 */
export function readJsonFile(path: string, options: { lenient?: boolean } = {}): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    if (options.lenient) return undefined
    throw new Error(`${path} exists but is not valid JSON. Refusing to guess what it meant.`, {
      cause: error,
    })
  }
}

/**
 * Write through a temporary file and rename, mode 0600. A truncated auth or
 * state file must never be a state the engine can wake up in.
 */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, path)
}

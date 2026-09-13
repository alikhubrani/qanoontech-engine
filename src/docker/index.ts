import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { findModule } from '../catalogue/index.js'
import { NETWORK_NAME, PROJECT_NAME } from '../render/compose.js'
import { stateDir } from '../state/store.js'

/**
 * Every Docker operation the engine performs. There are no others.
 *
 * This is the security boundary, and it is deliberately one small file so that
 * "audit it yourself" is a credible answer to a firm's security reviewer. The
 * engine holds the Docker socket, which is root on the host; what limits it is
 * not a proxy — a proxy would narrow nothing, since creating containers means
 * accepting arbitrary bind mounts — but the fact that every verb below resolves
 * its service names against the closed catalogue before it runs.
 *
 * Rules, and they are not negotiable:
 *
 *   - No `docker exec`. Not for diagnostics, not for backups, not once.
 *     `exec` into the database container is a complete client-data dump, and
 *     nothing else here comes close to that.
 *   - No caller-supplied arguments reach the command line. Callers name
 *     services from the catalogue; they do not pass flags.
 *   - No verb outside this file. If a route handler needs Docker, it needs a
 *     verb here first, reviewed on its own.
 */

export const COMPOSE_FILE = 'docker-compose.generated.yml'

export function composeFilePath(dir = stateDir()): string {
  return join(dir, COMPOSE_FILE)
}

export class UnknownService extends Error {
  constructor(readonly service: string) {
    super(
      `'${service}' is not a service in this deployment. ` +
        'The catalogue is closed; the engine will not act on a name it does not define.',
    )
  }
}

export interface CommandResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export interface DockerOptions {
  readonly composeFile?: string
  /** Where output should go while a long command runs. */
  readonly onOutput?: (chunk: string) => void
  /** Fed to stdin and closed. For credentials, so they never hit argv. */
  readonly input?: string
  /** Extra environment for the child. For credentials, so they never hit argv. */
  readonly env?: Readonly<Record<string, string>>
}

/** Reject anything the catalogue does not define, before it reaches Docker. */
function checkServices(services: readonly string[]): void {
  for (const service of services) {
    if (!findModule(service)) throw new UnknownService(service)
  }
}

async function compose(
  args: readonly string[],
  options: DockerOptions = {},
): Promise<CommandResult> {
  const file = options.composeFile ?? composeFilePath()
  return run('docker', ['compose', '--project-name', PROJECT_NAME, '--file', file, ...args], options)
}

function run(
  command: string,
  args: readonly string[],
  options: DockerOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env: options.env ? { ...process.env, ...options.env } : process.env,
    })
    if (options.input !== undefined) {
      child.stdin?.write(options.input)
      child.stdin?.end()
    }
    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stdout += text
      options.onOutput?.(text)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr += text
      options.onOutput?.(text)
    })

    child.on('error', (error) => {
      // A missing binary is a state the server has to describe, not a crash:
      // it resolves like any other failure, with the shell's own 127.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve({
          code: 127,
          stdout: '',
          stderr: `${command} is not installed, or is not on this container's PATH.`,
        })
        return
      }
      reject(error)
    })
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

// ---------------------------------------------------------------------------
// The verbs
// ---------------------------------------------------------------------------

/** Is there a Docker daemon, and can we talk to it? */
export async function available(): Promise<CommandResult> {
  return run('docker', ['version', '--format', '{{.Server.APIVersion}}'])
}

/**
 * Download images. Separated from `apply` on purpose: a pull that fails has
 * touched nothing that is running, which is what makes an update safe to
 * attempt.
 */
export async function pull(options?: DockerOptions): Promise<CommandResult> {
  return compose(['pull'], options)
}

/** Bring the deployment to what the generated file says it should be. */
export async function apply(options?: DockerOptions): Promise<CommandResult> {
  return compose(['up', '--detach', '--remove-orphans'], options)
}

export async function start(
  services: readonly string[],
  options?: DockerOptions,
): Promise<CommandResult> {
  checkServices(services)
  return compose(['start', ...services], options)
}

export async function stop(
  services: readonly string[],
  options?: DockerOptions,
): Promise<CommandResult> {
  checkServices(services)
  return compose(['stop', ...services], options)
}

export async function restart(
  services: readonly string[],
  options?: DockerOptions,
): Promise<CommandResult> {
  checkServices(services)
  return compose(['restart', ...services], options)
}

export async function logs(
  service: string,
  lines = 200,
  options?: DockerOptions,
): Promise<CommandResult> {
  checkServices([service])
  return compose(['logs', '--no-color', '--tail', String(lines), service], options)
}

export async function ps(options?: DockerOptions): Promise<CommandResult> {
  return compose(['ps', '--format', 'json'], options)
}

/**
 * Stop and remove containers. Volumes are never removed — there is no flag for
 * it here, and there should not be. The engine does not have a verb that can
 * destroy a firm's data.
 */
export async function down(options?: DockerOptions): Promise<CommandResult> {
  return compose(['down', '--remove-orphans'], options)
}

/** Check the generated file parses before anything is asked to run it. */
export async function validate(options?: DockerOptions): Promise<CommandResult> {
  return compose(['config', '--quiet'], options)
}

/** Every container's published ports, for the preflight's port check. */
export async function publishedPorts(): Promise<CommandResult> {
  return run('docker', ['ps', '--format', '{{.Names}}\t{{.Ports}}'])
}

/** The exact images the rendered file will run, authoritative for pulling. */
export async function plannedImages(options?: DockerOptions): Promise<CommandResult> {
  return compose(['config', '--images'], options)
}

/** Compose v2 present? Its absence is a preflight failure with its own name. */
export async function composeVersion(): Promise<CommandResult> {
  return run('docker', ['compose', 'version', '--short'])
}

/** Volume names under this project, for the is-this-a-reinstall check. */
export async function volumes(): Promise<CommandResult> {
  return run('docker', [
    'volume',
    'ls',
    '--filter',
    `label=com.docker.compose.project=${PROJECT_NAME}`,
    '--format',
    '{{.Name}}',
  ])
}

/**
 * Store the registry credential with the daemon, so `pull` can use it. The
 * token travels on stdin — an argv value is visible to every process on the
 * box for as long as the command runs.
 */
export async function login(registry: string, username: string, token: string): Promise<CommandResult> {
  return run('docker', ['login', registry, '--username', username, '--password-stdin'], {
    input: token,
  })
}

/**
 * The engine replacing itself — the one operation compose cannot express,
 * because a container cannot survive removing itself. A short-lived helper
 * (the official docker CLI image, digest-pinned at release) is started
 * detached with the socket; it pulls the new engine image, removes this
 * container, and re-creates it from the recorded run configuration. If the
 * helper dies mid-way the old image is still on disk and `rescue.sh` brings
 * the panel back by hand.
 *
 * UNTESTED AGAINST A REAL DAEMON — exercised only as constructed arguments
 * until there is a box. Treat with suspicion until then.
 */
/**
 * The run configuration every installation uses — the README's command,
 * rescue.sh, and self-update must agree on it, because a container cannot
 * inspect its own flags; this constant is that agreement.
 */
export const ENGINE_CONTAINER_NAME = 'qanoontech-engine'
export const ENGINE_RUN_ARGS: readonly string[] = [
  '--volume', '/var/run/docker.sock:/var/run/docker.sock',
  '--volume', 'qanoontech_engine:/var/lib/qanoontech-engine',
  '--publish', '8081:8080',
  '--restart', 'unless-stopped',
]

export function selfUpdateArgs(newImage: string, containerName: string, runArgs: readonly string[]): string[] {
  const script = [
    // Pull, or accept an image already on the box — a development build, or a
    // box that pre-pulled while it had connectivity. Either way the image
    // must exist before anything running is touched; if both fail, the chain
    // stops here and the old engine is still standing.
    `(docker pull ${shellQuote(newImage)} || docker image inspect ${shellQuote(newImage)} >/dev/null)`,
    `docker rm -f ${shellQuote(containerName)}`,
    `docker run -d --name ${shellQuote(containerName)} ${runArgs.map(shellQuote).join(' ')} ${shellQuote(newImage)}`,
  ].join(' && ')
  return [
    'run',
    '--detach',
    '--rm',
    '--volume',
    '/var/run/docker.sock:/var/run/docker.sock',
    'docker:cli',
    'sh',
    '-c',
    script,
  ]
}

export async function selfUpdate(
  newImage: string,
  containerName: string,
  runArgs: readonly string[],
): Promise<CommandResult> {
  return run('docker', selfUpdateArgs(newImage, containerName, runArgs))
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\''`)}'`
}

// ---------------------------------------------------------------------------
// Backup helpers
// ---------------------------------------------------------------------------
//
// The engine is deliberately not on the deployment's network, so it cannot
// reach `postgres` by name — and its own image carries no database tools. Both
// gaps close the same way: a short-lived helper container, run on the project
// network, from a postgres image that carries the client tools.
//
// **The helper's version and the module's version are pinned separately, and
// the helper must be the newer of the two.** This comment used to say the
// opposite — that using the deployment's own image meant pg_dump "can never be
// newer than the server" — and had the constraint backwards. pg_dump refuses a
// server *newer* than itself ("aborting because of server version mismatch",
// measured against a 17 server with the 15 client); a client newer than the
// server is fine. So the helper tracks the newest server this engine may meet,
// and the module pin stays where the firm's data directory is: a major version
// there is an on-disk format, and moving it is a dump-and-restore, never a
// tag change.
//
// These are the only verbs here that run `sh -c`. The scripts are fixed
// templates; the only variable pieces are file paths built from a
// timestamp-shaped id the backup service validates, and credentials, which
// travel as environment variables — never in the command line.

const POSTGRES_HELPER_IMAGE = 'postgres:17-alpine'
const BUSYBOX_HELPER_IMAGE = 'busybox'

/** The engine's own volume, as the README and rescue.sh mount it. */
export const ENGINE_VOLUME = 'qanoontech_engine'
export const PROJECT_NETWORK = `${PROJECT_NAME}_${NETWORK_NAME}`
const UPLOADS_VOLUME = `${PROJECT_NAME}_uploads_data`
const LOGS_VOLUME = `${PROJECT_NAME}_logs_data`

/**
 * Re-exported from `backup/target.ts`, which is the one place that decides
 * where the database is. The helpers below take a target and never a name:
 * they used to write `-h postgres` themselves, four times, and that was four
 * places to forget when the database stopped being a neighbour container.
 */
export type { DatabaseTarget } from '../backup/target.js'
import type { DatabaseTarget } from '../backup/target.js'

/**
 * The connection, as environment for the helper — never in the command line.
 * `PGHOST`/`PGPORT`/`PGSSLMODE` join the credentials that were already here.
 */
function connectionEnv(target: DatabaseTarget, database = target.dbName): Record<string, string> {
  return {
    PGHOST: target.host,
    PGPORT: String(target.port),
    PGSSLMODE: target.sslmode,
    PGPASSWORD: target.password,
    PGUSER: target.dbUser,
    PGDATABASE: database,
  }
}

/**
 * On the project network for the compose module, which is reachable only by
 * name from inside it. Off it for an external host: the default bridge reaches
 * the LAN and the internet, and the project network may not exist at all on a
 * deployment that renders no `postgres` service.
 */
function networkArgs(target: DatabaseTarget): string[] {
  return target.external ? [] : ['--network', PROJECT_NETWORK]
}

const PG_ENV = ['--env', 'PGHOST', '--env', 'PGPORT', '--env', 'PGSSLMODE', '--env', 'PGPASSWORD', '--env', 'PGUSER', '--env', 'PGDATABASE']

/** pg_dump to a gzipped SQL file on the engine volume, then verify the gzip. */
export async function dumpDatabase(
  target: DatabaseTarget,
  outPath: string,
  options?: DockerOptions,
): Promise<CommandResult> {
  return run(
    'docker',
    [
      'run', '--rm',
      ...networkArgs(target),
      '--volume', `${ENGINE_VOLUME}:/state`,
      ...PG_ENV,
      POSTGRES_HELPER_IMAGE,
      'sh', '-c',
      // --clean --if-exists so a restore replays onto a live schema; the
      // trailing gzip -t means a dump that does not verify never exists.
      `pg_dump --clean --if-exists | gzip > ${outPath} && gzip -t ${outPath}`,
    ],
    { ...options, env: connectionEnv(target) },
  )
}

export async function restoreDatabase(
  target: DatabaseTarget,
  inPath: string,
  options?: DockerOptions,
): Promise<CommandResult> {
  return run(
    'docker',
    [
      'run', '--rm',
      ...networkArgs(target),
      '--volume', `${ENGINE_VOLUME}:/state:ro`,
      ...PG_ENV,
      POSTGRES_HELPER_IMAGE,
      'sh', '-c',
      `gunzip -c ${inPath} | psql --set ON_ERROR_STOP=0 -q`,
    ],
    { ...options, env: connectionEnv(target) },
  )
}

/**
 * Run SQL against the server, in a named database, and hand back stdout.
 *
 * The drill needs three things the restore path does not: a scratch database
 * to create, row counts to read out of it, and the scratch database dropped
 * again. `PGDATABASE` is the connection target rather than the subject, so
 * creating `drill_x` means connecting to `postgres` and asking for it.
 */
export async function psqlQuery(
  target: DatabaseTarget,
  sql: string,
  options?: DockerOptions & { readonly database?: string },
): Promise<CommandResult> {
  return run(
    'docker',
    [
      'run', '--rm',
      ...networkArgs(target),
      ...PG_ENV,
      POSTGRES_HELPER_IMAGE,
      'psql', '-t', '-A', '--set', 'ON_ERROR_STOP=1', '-c', sql,
    ],
    { ...options, env: connectionEnv(target, options?.database ?? target.dbName) },
  )
}

/**
 * Replay a dump into a database that is not the live one.
 *
 * Same image and same pipe as `restoreDatabase`, pointed elsewhere. Separate
 * so that nothing which takes a database name can be handed the live one by a
 * caller that meant to drill.
 */
export async function restoreDatabaseInto(
  target: DatabaseTarget,
  database: string,
  inPath: string,
  options?: DockerOptions,
): Promise<CommandResult> {
  return run(
    'docker',
    [
      'run', '--rm',
      ...networkArgs(target),
      '--volume', `${ENGINE_VOLUME}:/state:ro`,
      ...PG_ENV,
      POSTGRES_HELPER_IMAGE,
      'sh', '-c',
      `gunzip -c ${inPath} | psql --set ON_ERROR_STOP=0 -q`,
    ],
    { ...options, env: connectionEnv(target, database) },
  )
}

export async function archiveUploads(outPath: string, options?: DockerOptions): Promise<CommandResult> {
  return run(
    'docker',
    [
      'run', '--rm',
      '--volume', `${UPLOADS_VOLUME}:/uploads:ro`,
      '--volume', `${ENGINE_VOLUME}:/state`,
      BUSYBOX_HELPER_IMAGE,
      'sh', '-c',
      `tar czf ${outPath} -C /uploads . && gzip -t ${outPath}`,
    ],
    options,
  )
}

/**
 * Every stored document, with its size, as `<bytes> <path>` lines.
 *
 * The engine mounts the Docker socket and its own state and nothing else, so it
 * cannot walk the uploads volume itself — a helper container does it, which is
 * the same arrangement every other file operation here uses. One spawn per
 * tick, whatever the file count.
 *
 * `.incoming` is skipped: those are part-uploads with no database row, swept
 * after six hours by the application, and copying one offsite means copying a
 * file that is about to be deleted.
 *
 * Stored names are sanitised to letters, digits, Arabic, `_` and `-` before
 * they reach disk (`buildStoredName` in the application), so a path never
 * contains a space and "first token is the size, the rest is the path" holds.
 */
export async function listUploads(options?: DockerOptions): Promise<CommandResult> {
  return run(
    'docker',
    [
      'run', '--rm',
      '--volume', `${UPLOADS_VOLUME}:/uploads:ro`,
      BUSYBOX_HELPER_IMAGE,
      'sh', '-c',
      `cd /uploads && find . -type f -not -path './.incoming/*' | while IFS= read -r f; do ` +
        `printf '%s %s\n' "$(stat -c %s "$f")" "\${f#./}"; done`,
    ],
    options,
  )
}

/**
 * The application's own error log, read from the volume it writes to.
 *
 * The support bundle collects `docker compose logs --tail 300` per service,
 * which is stdout. The application writes its structured lines to stdout
 * too, but 300 lines is minutes on a busy box, and the file it keeps for
 * exactly this purpose -- `error-<date>.log`, thirty days of it, on
 * `logs_data` -- was on a volume the engine never read. A bundle downloaded
 * an hour after a failure carried nothing about it. Criterion 13 of the
 * application's error-handling audit is that the bundle and the error log
 * meet; this is where they meet.
 *
 * The newest seven daily files, each tail-capped, so the bundle stays a
 * download rather than an archive. Only `error-*`: the combined log is every
 * request and the security log is the firm's twelve-month record of who signed
 * in, which is deliberately not something that leaves the premises because
 * somebody clicked "download diagnostics".
 *
 * An absent volume -- a box with no application installed -- is not an error;
 * the helper prints nothing.
 */
export async function readApplicationErrors(
  bytesPerFile = 300_000,
  options?: DockerOptions,
): Promise<CommandResult> {
  return run(
    'docker',
    [
      'run', '--rm',
      '--volume', `${LOGS_VOLUME}:/logs:ro`,
      BUSYBOX_HELPER_IMAGE,
      'sh', '-c',
      `cd /logs 2>/dev/null || exit 0; for f in $(ls error-*.log 2>/dev/null | sort | tail -n 7); do ` +
        `printf '### %s\n' "$f"; tail -c ${Math.trunc(bytesPerFile)} "$f"; done`,
    ],
    options,
  )
}

/**
 * Copy named documents out of the uploads volume so the engine can read them.
 *
 * The list arrives as a file on the engine's own volume rather than as
 * arguments, because a thousand paths is longer than a command line and
 * because a path is data, not syntax.
 */
export async function stageUploads(
  listPath: string,
  stageDir: string,
  options?: DockerOptions,
): Promise<CommandResult> {
  return run(
    'docker',
    [
      'run', '--rm',
      '--volume', `${UPLOADS_VOLUME}:/uploads:ro`,
      '--volume', `${ENGINE_VOLUME}:/state`,
      BUSYBOX_HELPER_IMAGE,
      'sh', '-c',
      `while IFS= read -r f; do mkdir -p "${stageDir}/$(dirname "$f")" && ` +
        `cp "/uploads/$f" "${stageDir}/$f"; done < ${listPath}`,
    ],
    options,
  )
}

/** Put documents back, from a directory the engine filled. */
/**
 * Who the application runs as, asked of its image.
 *
 * Derived rather than typed in. The Dockerfile says `adduser --uid 1001
 * nextjs`, which is a contract — but the running gid is whatever `adduser
 * --system` chose, and a number copied into this file is a number that is
 * wrong the day the Dockerfile changes. The image knows; ask it.
 *
 * `undefined` when the image cannot be run, so a restore can still complete
 * and *say* the ownership was not set, rather than fail outright.
 */
export async function appOwner(image: string, options?: DockerOptions): Promise<string | undefined> {
  const result = await run(
    'docker',
    ['run', '--rm', '--entrypoint', 'sh', image, '-c', 'id -u && id -g'],
    options,
  )
  if (result.code !== 0) return undefined
  const [uid, gid] = result.stdout.trim().split('\n').map((s) => s.trim())
  const owner = `${uid}:${gid}`
  return OWNER_PATTERN.test(owner) ? owner : undefined
}

/** `uid:gid`, digits only. It is interpolated into a shell command, so it is a shape and never free text. */
const OWNER_PATTERN = /^\d{1,10}:\d{1,10}$/

/**
 * The write half of every documents helper, as one string.
 *
 * `chown` after the copy, and the reason is the bug this fixed: the helper
 * runs as root, so everything it writes is root's. The application runs as
 * uid 1001. A recovered box listed all eighty of its documents and could not
 * accept a new one — reads succeed on 644, writes fail on a 755 directory
 * root owns — and the acceptance test had checked the count and never tried
 * an upload. A restored archive that cannot be written to is a read-only
 * copy of a firm's work, which is not what "restored" means.
 *
 * Exported so the shape is tested without a Docker daemon.
 */
export function uploadsWriteScript(copy: string, owner: string | undefined): string {
  if (owner === undefined) return copy
  if (!OWNER_PATTERN.test(owner)) throw new Error(`Not an owner: ${owner}`)
  return `${copy} && chown -R ${owner} /uploads`
}

export async function unstageUploads(
  stageDir: string,
  owner?: string,
  options?: DockerOptions,
): Promise<CommandResult> {
  return run(
    'docker',
    [
      'run', '--rm',
      '--volume', `${UPLOADS_VOLUME}:/uploads`,
      '--volume', `${ENGINE_VOLUME}:/state:ro`,
      BUSYBOX_HELPER_IMAGE,
      'sh', '-c',
      uploadsWriteScript(`cp -a ${stageDir}/. /uploads/`, owner),
    ],
    options,
  )
}

export async function restoreUploads(
  inPath: string,
  owner?: string,
  options?: DockerOptions,
): Promise<CommandResult> {
  return run(
    'docker',
    [
      'run', '--rm',
      '--volume', `${UPLOADS_VOLUME}:/uploads`,
      '--volume', `${ENGINE_VOLUME}:/state:ro`,
      BUSYBOX_HELPER_IMAGE,
      'sh', '-c',
      uploadsWriteScript(`tar xzf ${inPath} -C /uploads`, owner),
    ],
    options,
  )
}

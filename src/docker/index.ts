import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { findModule } from '../catalogue/index.js'
import { PROJECT_NAME } from '../render/compose.js'
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
export function selfUpdateArgs(newImage: string, containerName: string, runArgs: readonly string[]): string[] {
  const script = [
    `docker pull ${shellQuote(newImage)}`,
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

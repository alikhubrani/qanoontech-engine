#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { Command } from 'commander'
import { CATALOGUE, REQUIRED_MODULE_IDS, findModule } from './catalogue/index.js'
import * as docker from './docker/index.js'
import { buildPlan, writePlan } from './plan.js'
import {
  ensureGeneratedSecrets,
  loadSecrets,
  loadState,
  saveSecrets,
  saveState,
  stateDir,
} from './state/store.js'

/**
 * The engine's command line.
 *
 * Phase 1 has no web interface yet, and this is not a stopgap for it. The
 * renderer is the part that can be wrong in ways a UI hides — a bad compose
 * file looks like a working button — so it is exercised here first, where a bad
 * render is a diff you can read. Afterwards this stays: it is what `rescue.sh`
 * and CI drive, and it is how the deployment is worked on when the browser path
 * is the thing that has gone wrong.
 */

const program = new Command()
  .name('qanoontech-engine')
  .description('Control plane for a QanoonTech deployment')
  .showHelpAfterError()

// ---------------------------------------------------------------------------
// Looking
// ---------------------------------------------------------------------------

program
  .command('status')
  .description('What this deployment is configured to be')
  .action(() => {
    const state = loadState()
    const secrets = loadSecrets()
    const plan = buildPlan()

    console.log(`state          ${stateDir()}`)
    console.log(`version        ${state.version}`)
    if (state.previousVersion) console.log(`previous       ${state.previousVersion}`)
    console.log(`address        ${state.settings.bindAddress}:${state.settings.appPort}`)
    console.log(`secrets set    ${Object.keys(secrets).length}`)
    console.log(
      `modules on     ${[...REQUIRED_MODULE_IDS, ...state.enabled].join(', ') || '(none)'}`,
    )
    console.log('')

    if (plan.ok) {
      console.log(`plan           ready — ${plan.moduleIds.length} services`)
    } else {
      console.log('plan           not deployable:')
      for (const problem of plan.problems) console.log(`               - ${problem}`)
    }
  })

program
  .command('modules')
  .description('The catalogue, and what is on')
  .action(() => {
    const state = loadState()
    const on = new Set([...REQUIRED_MODULE_IDS, ...state.enabled])

    for (const module of CATALOGUE) {
      const mark = module.required ? '[required]' : on.has(module.id) ? '[on]' : '[off]'
      console.log(`${mark.padEnd(11)} ${module.id.padEnd(14)} ${module.cost.image.padStart(8)}  ${module.title}`)
      console.log(`${' '.repeat(12)}${module.summary}`)
    }
  })

// ---------------------------------------------------------------------------
// Changing what a deployment is
// ---------------------------------------------------------------------------

program
  .command('enable <module>')
  .description('Turn an optional module on')
  .action((id: string) => {
    const module = findModule(id)
    if (!module) fail(`No module named '${id}'. Try: qanoontech-engine modules`)
    if (module.required) fail(`'${id}' is part of the system and is always on.`)

    const state = loadState()
    if (!state.enabled.includes(id)) {
      saveState({ ...state, enabled: [...state.enabled, id] })
    }
    console.log(`${module.title} is on. It costs ${module.cost.image} and ${module.cost.memory}.`)
    console.log("Run 'apply' to deploy it.")
  })

program
  .command('disable <module>')
  .description('Turn an optional module off')
  .action((id: string) => {
    const module = findModule(id)
    if (!module) fail(`No module named '${id}'.`)
    if (module.required) fail(`'${id}' is part of the system and cannot be turned off.`)

    const state = loadState()
    saveState({ ...state, enabled: state.enabled.filter((m) => m !== id) })
    console.log(`${module.title} is off. Run 'apply' to remove it.`)
  })

program
  .command('config <module> <json>')
  .description("Set a module's configuration, as a JSON object")
  .action((id: string, json: string) => {
    const module = findModule(id)
    if (!module) fail(`No module named '${id}'.`)

    let value: unknown
    try {
      value = JSON.parse(json)
    } catch {
      fail(`That is not valid JSON. Expected something like '{"sharedDriveId":"0A1b..."}'`)
    }

    // Validated here as well as at resolve time, so a typo is refused when it
    // is made rather than at the moment someone is trying to deploy.
    const parsed = module.config.safeParse(value)
    if (!parsed.success) {
      console.error(`That configuration is not valid for '${module.title}':`)
      for (const issue of parsed.error.issues) {
        const path = issue.path.join('.')
        console.error(`  - ${path ? `${path}: ` : ''}${issue.message}`)
      }
      process.exit(1)
    }

    const state = loadState()
    saveState({ ...state, config: { ...state.config, [id]: value } })
    console.log(`Configuration saved for ${module.title}.`)
  })

program
  .command('version <version>')
  .description('Set the QanoonTech version this deployment runs')
  .action((version: string) => {
    const state = loadState()
    if (state.version === version) {
      console.log(`Already on ${version}.`)
      return
    }
    saveState({ ...state, previousVersion: state.version, version })
    console.log(`${state.version} → ${version}. Run 'apply' to deploy it.`)
  })

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

const secrets = program.command('secrets').description('Credentials, on the engine’s own volume')

secrets
  .command('init')
  .description('Generate any missing secret. Existing ones are left alone')
  .action(() => {
    const { secrets: next, created } = ensureGeneratedSecrets(loadSecrets())
    saveSecrets(next)
    if (created.length === 0) {
      console.log('Nothing to generate; every secret is already set.')
    } else {
      console.log(`Generated: ${created.join(', ')}`)
      console.log('Values are not shown. Nobody needs to type them.')
    }
  })

secrets
  .command('set <name>')
  .description('Set a supplied secret, read from stdin')
  .action((name: string) => {
    const value = readFileSync(0, 'utf8').trim()
    if (value === '') fail('Nothing on stdin. Pipe the value in.')
    saveSecrets({ ...loadSecrets(), [name]: value })
    console.log(`${name} set.`)
  })

secrets
  .command('list')
  .description('Which secrets are set. Never their values')
  .action(() => {
    const names = Object.keys(loadSecrets()).sort()
    console.log(names.length > 0 ? names.join('\n') : '(none set)')
  })

// ---------------------------------------------------------------------------
// Deploying
// ---------------------------------------------------------------------------

program
  .command('render')
  .description('Render the compose file')
  .option('--stdout', 'print it instead of writing it')
  .action((options: { stdout?: boolean }) => {
    const plan = requirePlan()
    if (options.stdout) {
      process.stdout.write(plan.yaml)
      return
    }
    const path = writePlan(plan.yaml)
    console.log(`Wrote ${path} — ${plan.moduleIds.length} services.`)
  })

program
  .command('apply')
  .description('Render, check, pull and bring the deployment up')
  .option('--skip-pull', 'do not download images first')
  .action(async (options: { skipPull?: boolean }) => {
    const plan = requirePlan()
    const path = writePlan(plan.yaml)
    console.log(`Wrote ${path}`)

    const valid = await docker.validate()
    if (valid.code !== 0) {
      console.error('Docker refused the generated file. This is an engine bug, not your config:')
      console.error(valid.stderr.trim())
      process.exit(1)
    }

    // Pull before touching anything running: an update that fails to download
    // has changed nothing, which is what makes it safe to attempt.
    if (!options.skipPull) {
      console.log('Downloading images…')
      const pulled = await docker.pull({ onOutput: (c) => process.stderr.write(c) })
      if (pulled.code !== 0) {
        console.error('Download failed. Nothing running has been touched.')
        process.exit(1)
      }
    }

    console.log('Applying…')
    const applied = await docker.apply({ onOutput: (c) => process.stderr.write(c) })
    process.exit(applied.code === 0 ? 0 : 1)
  })

for (const verb of ['pull', 'down'] as const) {
  program
    .command(verb)
    .description(verb === 'pull' ? 'Download images' : 'Stop and remove containers. Volumes are kept')
    .action(async () => {
      const result = await docker[verb]({ onOutput: (c) => process.stderr.write(c) })
      process.exit(result.code === 0 ? 0 : 1)
    })
}

for (const verb of ['start', 'stop', 'restart'] as const) {
  program
    .command(`${verb} [services...]`)
    .description(`${verb} services, or all of them`)
    .action(async (services: string[]) => {
      const result = await docker[verb](services, { onOutput: (c) => process.stderr.write(c) })
      process.exit(result.code === 0 ? 0 : 1)
    })
}

program
  .command('logs <service>')
  .description('Recent output from one service')
  .option('-n, --lines <count>', 'how many lines', '200')
  .action(async (service: string, options: { lines: string }) => {
    const result = await docker.logs(service, Number(options.lines) || 200)
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
    process.exit(result.code === 0 ? 0 : 1)
  })

program
  .command('ps')
  .description('What is running')
  .action(async () => {
    const result = await docker.ps()
    process.stdout.write(result.stdout || result.stderr)
    process.exit(result.code === 0 ? 0 : 1)
  })

// ---------------------------------------------------------------------------

function requirePlan(): { yaml: string; moduleIds: readonly string[] } {
  const plan = buildPlan()
  if (!plan.ok) {
    console.error('This deployment cannot be rendered:')
    for (const problem of plan.problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  return plan
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

try {
  await program.parseAsync(process.argv)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

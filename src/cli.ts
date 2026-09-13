#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { Writable } from 'node:stream'
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
  .action(async () => {
    const state = loadState()
    const secrets = loadSecrets()
    const plan = await buildPlan()

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

    /*
     * The assessment, here, because this is the command anyone runs without
     * being asked to. A firm's backups stopped for three days and every screen
     * said green -- nothing had failed, it had stopped being asked -- so the
     * state belongs on the page people already look at rather than behind a
     * subcommand they would have to suspect something to run. It is the same
     * function the panel's overview draws, so the two cannot disagree.
     */
    const { readDeployment } = await import('./health/deployment.js')
    const assessment = await readDeployment()
    const mark = assessment.verdict === 'protected' ? '✓' : assessment.verdict === 'attention' ? '!' : '✗'
    const word =
      assessment.verdict === 'protected' ? 'protected' : assessment.verdict === 'attention' ? 'needs attention' : 'AT RISK'
    console.log('')
    console.log(`verdict        ${mark} ${word}`)
    if (assessment.application.running) console.log(`running        ${assessment.application.running}`)
    console.log(`backups        ${assessment.backups.detail}`)
    console.log(
      `offsite        ${assessment.offsite.enabled ? (assessment.offsite.ready ? assessment.offsite.label : `not usable — ${assessment.offsite.reason}`) : 'off'}`,
    )
    console.log(
      `recovery       ${assessment.recovery.passphraseSet ? `snapshot copied ${assessment.recovery.lastCopiedAt ?? 'never'}` : 'no passphrase'}`,
    )
    for (const finding of assessment.findings) {
      console.log(`               ${finding.level === 'risk' ? '✗' : '!'} ${finding.title} — ${finding.detail}`)
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
      fail(`That is not valid JSON. Expected something like '{"host":"smtp.example.com"}'`)
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
  .command('remove <name>')
  .description('Delete a stored secret. Refuses one the deployment still needs')
  .option('--force', 'remove it anyway')
  .action(async (name: string, options: { force?: boolean }) => {
    const { loadSecrets, saveSecrets, GENERATED_SECRETS } = await import('./state/store.js')
    const { CATALOGUE } = await import('./catalogue/index.js')
    const { loadState } = await import('./state/store.js')

    const secrets = loadSecrets()
    if (!(name in secrets)) fail(`${name} is not stored.`)

    /*
     * A secret can be stale two ways: nothing declares it any more (a module
     * that was retired), or nothing has *yet* (a module not turned on). Only
     * the first is safe to remove without asking, and the difference is not
     * visible from the name — so the check is against what this deployment
     * actually runs.
     */
    if (!options.force) {
      if (GENERATED_SECRETS.some((g) => g.name === name)) {
        fail(`${name} is generated for this deployment and removing it would break it. --force if you mean it.`)
      }
      const enabled = new Set(loadState().enabled)
      const claimedBy = CATALOGUE.filter(
        (m) => (m.required || enabled.has(m.id)) && m.secrets.some((secret) => secret.name === name),
      )
      if (claimedBy.length > 0) {
        fail(`${name} is used by ${claimedBy.map((m) => m.title).join(', ')}. --force if you mean it.`)
      }
    }

    const { [name]: _removed, ...rest } = secrets
    saveSecrets(rest)
    console.log(`${name} removed.`)
    // The snapshot carries secrets, so the copy in the store still holds it
    // until the next tick replaces it. Say so rather than implying it is gone
    // everywhere.
    console.log('The offsite snapshot still carries it until the next tick rewrites it.')
  })

secrets
  .command('list')
  .description('Which secrets are set. Never their values')
  .action(() => {
    const names = Object.keys(loadSecrets()).sort()
    console.log(names.length > 0 ? names.join('\n') : '(none set)')
  })

// ---------------------------------------------------------------------------
// Preflight, versions, rollback
// ---------------------------------------------------------------------------

/**
 * Backups, and the one command that proves they are backups.
 */
const backup = program.command('backup').description('Copies of the database, and proving one restores')

backup
  .command('list')
  .description('Every set on this box, newest first')
  .action(async () => {
    const { listBackups } = await import('./backup/service.js')
    const sets = listBackups()
    if (sets.length === 0) {
      console.log('No backups yet.')
      return
    }
    for (const set of sets) {
      const size = ((set.databaseBytes + set.uploadsBytes) / 1024 / 1024).toFixed(1)
      console.log(`${set.id}  ${set.trigger.padEnd(11)} ${size.padStart(6)} MB${set.includesUploads ? '  +documents' : ''}`)
    }
    console.log(`\n${sets.length} set(s).`)
  })

backup
  .command('now')
  .description('Take a set right now')
  .option('--database-only', 'skip the documents archive')
  .action(async (options: { databaseOnly?: boolean }) => {
    const { takeBackup } = await import('./backup/service.js')
    const outcome = await takeBackup('manual', undefined, options.databaseOnly ? 'database' : 'full')
    console.log(outcome.detail)
    process.exit(outcome.ok ? 0 : 1)
  })

backup
  .command('restore <id>')
  .description('Replace the live database with a set. Stops the application while it runs')
  .option('--yes', 'proceed without the confirmation prompt')
  .action(async (id: string, options: { yes?: boolean }) => {
    /*
     * Restore existed only in the web panel, which is the same asymmetry
     * `apply` had twice -- once for the registry login, once for the
     * pre-update backup. Recovery is the thing most likely to be done from a
     * shell, on a box whose panel may be exactly what is not working.
     *
     * `--yes` is required rather than offered. This replaces a firm's live
     * database and stops the application to do it; a command that does that
     * because somebody pressed up-arrow and return is the wrong shape. There
     * is no prompt to answer instead, deliberately: this runs over ssh in
     * scripts and a prompt that cannot be seen is worse than a flag that must
     * be typed.
     */
    if (!options.yes) {
      console.error(`This replaces the live database with backup ${id}.`)
      console.error('Everything written since it was taken is lost, and the application stops while it runs.')
      console.error('A safety copy is taken first, so this is undoable — but it is not nothing.')
      console.error('')
      console.error(`Re-run with --yes to proceed:  backup restore ${id} --yes`)
      process.exit(1)
    }

    const { restoreBackup } = await import('./backup/service.js')
    const result = await restoreBackup(id)
    for (const step of result.steps) {
      console.log(`  ${step.ok ? 'ok  ' : 'FAIL'}  ${step.step}${step.detail ? `  ${step.detail}` : ''}`)
    }
    console.log(result.ok ? `\nRestored ${id}.` : '\nThe restore did not finish. The application may be stopped.')
    process.exit(result.ok ? 0 : 1)
  })

backup
  .command('drill [id]')
  .description('Restore a set into a scratch database and time it — the only proof a backup is one')
  .action(async (id?: string) => {
    const { drillAndRecord } = await import('./backup/drill.js')
    console.log('Restoring into a scratch database. The live one is not touched.')
    const result = await drillAndRecord(id)
    console.log(result.detail)
    if (result.ok && result.restoreMs !== undefined) {
      console.log(`\nRecovery time for the database: ${(result.restoreMs / 1000).toFixed(1)}s.`)
      console.log('Documents restore separately and are the slower half; this number is the database alone.')
    }
    process.exit(result.ok ? 0 : 1)
  })

/** Where the second copy goes, and whether it actually goes there. */
const offsite = program.command('offsite').description('The copy of every backup that is not on this box')

offsite
  .command('status')
  .description('Where backups are copied to, and whether the credentials work')
  .action(async () => {
    const { loadState } = await import('./state/store.js')
    const { offsiteStore } = await import('./backup/store.js')
    const { listBackups } = await import('./backup/service.js')
    const { readOffsite } = await import('./backup/offsite.js')

    const settings = loadState().settings
    console.log(`enabled    ${settings.backupOffsiteEnabled}`)
    console.log(`endpoint   ${settings.backupS3Endpoint || '(not set)'}`)
    console.log(`bucket     ${settings.backupS3Bucket || '(not set)'}`)
    console.log(`region     ${settings.backupS3Region}`)
    if (settings.backupS3Prefix) console.log(`prefix     ${settings.backupS3Prefix}`)

    const { store, reason } = offsiteStore()
    if (!store) {
      console.log(`\nnot usable — ${reason}`)
      process.exit(1)
    }

    const sets = listBackups()
    const waiting = sets.filter((set) => !readOffsite(set.id).uploadedAt)
    console.log(`\n${sets.length} set(s) here, ${waiting.length} not yet copied to ${store.label}.`)
    if (waiting.length > 0) console.log(`oldest waiting: ${waiting.at(-1)!.id}`)
  })

offsite
  .command('use-s3 <endpoint> <bucket>')
  .description('Send backups to S3-compatible storage (Cloudflare R2). Set the keys with `secrets set` first')
  .option('--region <region>', 'credential-scope region; R2 wants "auto"', 'auto')
  .option('--prefix <prefix>', 'key prefix, so one bucket can hold several deployments')
  .action(async (endpoint: string, bucket: string, options: { region: string; prefix?: string }) => {
    const { loadState, saveState, loadSecrets } = await import('./state/store.js')
    const secrets = loadSecrets()
    for (const name of ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
      if (!secrets[name]) {
        console.error(`${name} is not stored. Set it first:  secrets set ${name}`)
        process.exit(1)
      }
    }

    const state = loadState()
    saveState(
      {
        ...state,
        settings: {
          ...state.settings,
          backupOffsiteEnabled: true,
          backupS3Endpoint: endpoint.replace(/\/$/, ''),
          backupS3Bucket: bucket,
          backupS3Region: options.region,
          backupS3Prefix: options.prefix ?? '',
        },
      },
    )
    console.log(`Offsite is now ${bucket} at ${endpoint}.`)
    console.log("Run 'offsite test' to prove the credentials before trusting it.")
  })

/**
 * What is in the bucket, and bringing one back — from a shell.
 *
 * These existed only on the web panel, which contradicted the rule the engine
 * is built on: it has to work when the application does not. A firm recovering
 * onto a new machine has a terminal and a bucket, and quite possibly no panel
 * yet — so the path home cannot be a page. `fetchSet` and `listRemote` were
 * already written and tested; only the shell could not reach them.
 *
 * `fetch` puts the set in the ordinary local list and stops. It does not
 * restore: bringing a copy back and overwriting the live database are different
 * decisions, and `backup restore` is where the second one is made. Drill it
 * first — that is the point of having it on disk.
 */
offsite
  .command('list')
  .description('Every set in the bucket, and whether it is also on this box')
  .action(async () => {
    const { listRemote } = await import('./backup/offsite.js')
    const result = await listRemote()
    if (!result.ok) {
      console.error(`Could not read the store: ${result.detail}`)
      process.exit(1)
    }
    if (result.sets.length === 0) {
      console.log('No sets in the store.')
      return
    }
    for (const set of result.sets) {
      const size = `${(set.bytes / 1_048_576).toFixed(2)} MB`.padStart(9)
      // "here" is the useful half: it says which of these you would have to
      // fetch before you could restore them.
      console.log(`${set.name}  ${String(set.files).padStart(3)} file(s) ${size}  ${set.local ? 'here' : 'store only'}`)
    }
    console.log(`\n${result.sets.length} set(s) in the store, ${result.sets.filter((s) => !s.local).length} not on this box.`)
  })

offsite
  .command('fetch <id>')
  .description('Bring a set back from the store into the local list. Does not restore it')
  .action(async (id: string) => {
    const { fetchSet } = await import('./backup/offsite.js')
    const { AuditLog } = await import('./server/audit.js')

    console.log(`fetching  ${id}…`)
    const result = await fetchSet(id)
    new AuditLog().record(result.ok ? 'offsite-fetched' : 'offsite-failed', { detail: result.detail })

    if (!result.ok) {
      console.error(result.detail)
      process.exit(1)
    }
    console.log(result.detail)
    console.log(`\nIt is in the local list now. Prove it before you trust it:\n  backup drill ${id}`)
  })

offsite
  .command('test')
  .description('Write a small object, read it back, and delete it — proof, not configuration')
  .action(async () => {
    const { offsiteStore } = await import('./backup/store.js')
    const { store, reason } = offsiteStore()
    if (!store) {
      console.error(`Offsite is not usable: ${reason}`)
      process.exit(1)
    }

    /*
     * A round trip, not a list. Listing proves the credential can read; a firm
     * finds out whether it can *write* at 2am on the night it matters, which
     * is the wrong time. The same probe the panel runs.
     */
    const { probeOffsite } = await import('./backup/offsite.js')
    const result = await probeOffsite(store)
    for (const step of result.steps) console.log(`${step.ok ? 'ok  ' : 'FAIL'}  ${step.step.padEnd(7)} ${step.detail}`)
    console.log(result.ok ? `\n${store.label} is writable and readable from this box.` : '\nDo not trust this store until the failure above is fixed.')
    process.exit(result.ok ? 0 : 1)
  })

program
  .command('preflight')
  .description('Check this machine before installing, or after anything changed')
  .action(async () => {
    const { runPreflight, preflightBlocked } = await import('./preflight/index.js')
    const checks = await runPreflight()
    for (const check of checks) {
      const mark = check.status === 'pass' ? '✓' : check.status === 'warn' ? '!' : '✗'
      console.log(`${mark} ${check.title.padEnd(22)} ${check.detail}`)
    }
    if (preflightBlocked(checks)) {
      console.error('\nBlocked. Fix the ✗ lines before deploying.')
      process.exit(1)
    }
  })

program
  .command('versions')
  .description('Published versions, from the registry')
  .action(async () => {
    const { listVersions, storedRegistryAuth } = await import('./registry.js')
    const auth = storedRegistryAuth()
    if (!auth) fail('No registry credential is set. Set GHCR_USERNAME and GHCR_TOKEN via secrets.')
    const result = await listVersions(auth)
    if (!result.ok) fail(result.detail)
    console.log(result.versions.join('\n') || '(none published)')
  })

program
  .command('rollback')
  .description('Configure the previously installed version. Run apply afterwards')
  .action(async () => {
    const { rollbackVersion } = await import('./server/jobs.js')
    const { stateDir } = await import('./state/store.js')
    const result = rollbackVersion(stateDir())
    if (!result.ok) fail(result.detail)
    console.log(result.detail)
    console.log("Run 'apply' to deploy it.")
  })

program
  .command('self-update <version>')
  .description("Replace the engine's own container via a helper")
  .option('--name <name>', 'the engine container name', 'qanoontech-engine')
  .option('--image <image>', 'full image reference, overriding the published one')
  .action(async (version: string, options: { name: string; image?: string }) => {
    const { selfUpdate, ENGINE_RUN_ARGS } = await import('./docker/index.js')
    const image = options.image ?? `ghcr.io/alikhubrani/qanoontech-engine:${version}`
    const result = await selfUpdate(image, options.name, ENGINE_RUN_ARGS)
    if (result.code !== 0) fail(result.stderr.trim() || 'Could not start the update helper.')
    console.log('Update helper started. This container will be replaced in a moment.')
  })

// ---------------------------------------------------------------------------
// Where the database is
// ---------------------------------------------------------------------------

/**
 * One fact — is a `DATABASE_URL` stored — decides whether the database is the
 * compose module or somewhere else. These commands set and unset that fact and
 * say which way it currently points. Configured from a shell and never from
 * the panel: pointing a running deployment at the wrong database is the kind of
 * mistake that should require a terminal.
 */
const database = program.command('database').description('Where the application’s database is')

database
  .command('status')
  .description('Which database this deployment uses, and whether it answers')
  .action(async () => {
    const { databaseTarget } = await import('./backup/target.js')
    const resolved = databaseTarget()
    if (!resolved.ok) fail(resolved.detail)
    const t = resolved.target
    console.log(`where          ${t.external ? 'external' : 'this deployment (the postgres module)'}`)
    console.log(`host           ${t.host}:${t.port}`)
    console.log(`database       ${t.dbName}`)
    console.log(`user           ${t.dbUser}`)
    if (t.external) console.log(`sslmode        ${t.sslmode}`)
    const probe = await docker.psqlQuery(t, 'SELECT version()')
    if (probe.code !== 0) {
      console.log(`\nnot reachable — ${(probe.stderr || '').trim().slice(0, 200)}`)
      process.exit(1)
    }
    console.log(`server         ${probe.stdout.trim().split(' ').slice(0, 2).join(' ')}`)
  })

database
  .command('use')
  .description('Use a database elsewhere. The URL is read from stdin and proven before it is stored')
  .action(async () => {
    const { DATABASE_URL } = await import('./backup/target.js')
    const { proveDatabaseUrl } = await import('./backup/database-switch.js')
    const { loadSecrets, saveSecrets } = await import('./state/store.js')

    const url = readFileSync(0, 'utf8').trim()
    if (url === '') fail('Nothing on stdin. Pipe the URL in.')
    /*
     * Proven before stored, as the S3 keys were, and by the same checks the
     * panel runs (`backup/database-switch.ts`): it answers, its sslmode does
     * not promise what the server cannot give, and the role can create the
     * drill's scratch database.
     */
    const proof = await proveDatabaseUrl(url)
    if (!proof.ok) fail(`${proof.detail}\nNothing was changed.`)
    const parsed = { target: proof.target! }
    const probe = { stdout: proof.server ?? '' }
    saveSecrets({ ...loadSecrets(), [DATABASE_URL]: url })
    console.log(`Database is now ${parsed.target.host}:${parsed.target.port}/${parsed.target.dbName} — ${probe.stdout.trim().split(' ').slice(0, 2).join(' ')}`)
    console.log('The postgres module will not be rendered. Run `apply` to move the application over.')
    console.log('The old postgres_data volume is kept; `database use-local` points back at it.')
  })

database
  .command('use-local')
  .description('Go back to the postgres module in this deployment')
  .action(async () => {
    const { DATABASE_URL } = await import('./backup/target.js')
    const { loadSecrets, saveSecrets } = await import('./state/store.js')
    const secrets = loadSecrets()
    if (!secrets[DATABASE_URL]) fail('The database is already local.')
    const { [DATABASE_URL]: _gone, ...rest } = secrets
    saveSecrets(rest)
    console.log('Database is the postgres module again. Run `apply` to move the application back.')
    console.log('Whatever was written to the external database since the switch is not in the local volume.')
  })

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

/**
 * Everything else the engine copies offsite is useless without the snapshot.
 * A restored database with no `DATABASE_URL`, no JWT secret and no record of
 * which version or which modules a firm ran is a pile of rows.
 */
const recovery = program.command('recovery').description('The copy of this engine that is not on this box')

recovery
  .command('passphrase')
  .description('Set the recovery passphrase, read from stdin. Without it nothing is copied')
  .action(async () => {
    const { loadSecrets, saveSecrets } = await import('./state/store.js')
    const { RECOVERY_PASSPHRASE, clearKeyCache } = await import('./backup/snapshot.js')

    const passphrase = readFileSync(0, 'utf8').trim()
    if (passphrase === '') fail('Nothing on stdin. Pipe the passphrase in.')
    if (passphrase.length < 12) fail('Too short. This is the only thing standing between a bucket and every credential this deployment holds.')

    const secrets = loadSecrets()
    const replacing = Boolean(secrets[RECOVERY_PASSPHRASE])
    saveSecrets({ ...secrets, [RECOVERY_PASSPHRASE]: passphrase })
    clearKeyCache()

    console.log(replacing ? 'Recovery passphrase replaced.' : 'Recovery passphrase set.')
    if (replacing) {
      // The old snapshot in the bucket is still sealed under the old
      // passphrase. Say so, because "I changed it" and "the copy I would
      // restore from needs the previous one" are easy to hold at once.
      console.log('The snapshot already in the store still opens with the *previous* passphrase')
      console.log('until the next tick replaces it. Keep both until `recovery status` says copied.')
    }
    console.log('\nWrite it down somewhere that survives this machine. Lose it and the')
    console.log('snapshot cannot be opened by anyone, including you.')
  })

recovery
  .command('status')
  .description('Whether this deployment could be brought back, and from what')
  .action(async () => {
    const { loadSecrets } = await import('./state/store.js')
    const { offsiteStore } = await import('./backup/store.js')
    const { SNAPSHOT_KEY, RECOVERY_PASSPHRASE } = await import('./backup/snapshot.js')

    const secrets = loadSecrets()
    console.log(`passphrase     ${secrets[RECOVERY_PASSPHRASE] ? 'set' : '(not set — nothing is being copied)'}`)

    const { store, reason } = offsiteStore()
    if (!store) {
      console.log(`store          not usable — ${reason}`)
      process.exit(1)
    }
    console.log(`store          ${store.label}`)

    const found = await store.stat(SNAPSHOT_KEY)
    console.log(`snapshot       ${found ? `${found.size} bytes at ${SNAPSHOT_KEY}` : '(not in the store)'}`)
    if (!found) {
      console.log('\nThis deployment cannot currently be recovered from the store.')
      process.exit(1)
    }
    console.log('\nA bare machine could be brought back with the endpoint, the bucket,')
    console.log('two keys and the passphrase.')
  })

recovery
  .command('run')
  .description('Bring a deployment back onto this machine from the store. For a box with nothing on it')
  .requiredOption('--endpoint <url>', 'S3 endpoint')
  .requiredOption('--bucket <bucket>', 'bucket name')
  .option('--force', 'proceed even though this box already has engine state')
  .action(async (options: { endpoint: string; bucket: string; force?: boolean }) => {
    /*
     * The whole point of the programme, in one command: four values and a
     * passphrase, and a machine that has never seen this deployment becomes it.
     *
     * Every step here already exists and is tested on its own. What this adds
     * is the order, and the order is the part that matters — the compose file
     * is *rendered*, never restored, because it is an output; the database is
     * restored before documents because a document index is read from the set
     * and not from the database; and a drill runs at the end so recovery proves
     * itself rather than announcing success.
     */
    const { applySnapshot, fetchSnapshot } = await import('./backup/snapshot.js')
    const { fetchSet, listRemote } = await import('./backup/offsite.js')
    const { restoreBackup } = await import('./backup/service.js')
    const { restoreDocuments } = await import('./backup/documents.js')
    const { runDrill } = await import('./backup/drill.js')
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const step = (n: number, what: string) => console.log(`\n[${n}/7] ${what}`)

    const store = await recoveryStore(options.endpoint, options.bucket)
    const passphrase = await ask('Recovery passphrase: ')
    if (!passphrase) fail('A passphrase is needed; the snapshot cannot be opened without it.')

    const work = mkdtempSync(join(tmpdir(), 'qt-recover-'))
    try {
      step(1, 'Opening the engine snapshot')
      const got = await fetchSnapshot(store, passphrase, join(work, 'state.enc'))
      if (!got.ok) fail(got.detail)
      const body = got.body!
      console.log(`      taken ${body.takenAt} by engine ${body.engineVersion}`)

      step(2, 'Writing state and secrets onto this box')
      const applied = applySnapshot(body, undefined, { force: options.force ?? false })
      if (!applied.ok) fail(applied.detail)
      console.log(`      ${applied.detail}`)

      step(3, 'Rendering the compose file from that state')
      // Rendered, not restored. A stored compose file would pin whatever the
      // dead engine last wrote, against whichever engine is running now.
      const plan = await requirePlan()
      const path = writePlan(plan.yaml)
      console.log(`      ${path} — ${plan.moduleIds.join(', ')}`)

      step(4, 'Starting the deployment')
      /*
       * Log the daemon in first, using the credentials that arrived in the
       * snapshot a moment ago.
       *
       * `jobs.ts` already carries this lesson in a comment — compose's registry
       * checks use the daemon's *stored* login, so `apply` fails `unauthorized`
       * even when every image is present — and this path reintroduced it by
       * calling `docker.apply()` directly. It only surfaced on a box whose
       * images had been deleted, which is precisely the box recovery runs on
       * and precisely why the rehearsal was worth doing.
       */
      const { storedRegistryAuth, REGISTRY } = await import('./registry.js')
      const auth = storedRegistryAuth()
      if (auth) {
        const loggedIn = await docker.login(REGISTRY, auth.username, auth.token)
        if (loggedIn.code !== 0) {
          fail(`Could not sign in to ${REGISTRY}: ${(loggedIn.stderr || '').slice(0, 200)}`)
        }
        console.log(`      signed in to ${REGISTRY} as ${auth.username}`)
      } else {
        console.log('      no registry credentials in the snapshot; public images only')
      }

      const applyResult = await docker.apply()
      if (applyResult.code !== 0) fail(`docker compose failed: ${(applyResult.stderr || '').slice(0, 300)}`)
      console.log('      containers up')

      step(5, 'Finding the newest backup in the store')
      const remote = await listRemote()
      if (!remote.ok) fail(remote.detail)
      const newest = remote.sets[0]
      if (!newest) fail('There are no backup sets in the store; the database cannot be restored.')
      console.log(`      ${newest.name} (${(newest.bytes / 1_048_576).toFixed(2)} MB)`)
      const fetched = await fetchSet(newest.name)
      if (!fetched.ok) fail(fetched.detail)

      /*
       * Restore the box, not necessarily the database.
       *
       * The snapshot carries DATABASE_URL. When it is set, the database was
       * never on the machine that died — it is on its own server and, in every
       * recovery this command is for, it is still there with the firm's data
       * in it. Restoring the newest set over it would replace a live database
       * with a copy up to an hour old, silently, as the last step of a command
       * called "recover". That is the one outcome worse than the outage.
       *
       * So with an external database the set is fetched for its document
       * index only, the database is left where it is, and what it holds is
       * counted and printed so "recovered" says what is actually there. If the
       * external server was also lost, that is a deliberate `backup restore
       * <id> --yes` and the output says so.
       */
      const { databaseTarget, databaseIsExternal } = await import('./backup/target.js')
      if (databaseIsExternal()) {
        step(6, 'The database is external — it survived. Restoring documents only')
        const t = databaseTarget()
        if (!t.ok) fail(t.detail)
        console.log(`      database is ${t.target.host}:${t.target.port}/${t.target.dbName} and was not on the box that died`)
        const probe = await docker.psqlQuery(t.target, 'SELECT (SELECT count(*) FROM users) || \' users, \' || (SELECT count(*) FROM cases) || \' cases, \' || (SELECT count(*) FROM clients) || \' clients\'')
        if (probe.code !== 0) {
          fail(`      it cannot be read: ${(probe.stderr || '').trim().slice(0, 200)}\n      If that server is gone too, restore into a new one deliberately:  backup restore ${newest.name} --yes`)
        }
        console.log(`      it holds ${probe.stdout.trim()} — left exactly as it is`)
        if (/^0 users/.test(probe.stdout.trim())) {
          console.log('      (empty — if the data should be there, it was lost with the server: backup restore ' + newest.name + ' --yes)')
        }
      } else {
        step(6, 'Restoring the database, then the documents it names')
        const restored = await restoreBackup(newest.name)
        for (const s of restored.steps) console.log(`      ${s.ok ? '✓' : '✗'} ${s.step} — ${s.detail}`)
        if (!restored.ok) fail('The restore did not complete.')
      }

      /*
       * Documents were on the box, so they come back either way, and from the
       * set's own index so a recovered deployment gets the files that existed
       * when that backup was taken rather than whatever is in the bucket now.
       */
      const { BACKUPS_DIR } = await import('./backup/service.js')
      const { stateDir } = await import('./state/store.js')
      const docs = await restoreDocuments(join(stateDir(), BACKUPS_DIR, newest.name))
      console.log(`      ${docs.detail}`)

      step(7, 'Proving it: restoring that set again into a scratch database')
      const drill = await runDrill(newest.name)
      console.log(`      ${drill.detail}`)
      if (!drill.ok) fail('Recovery finished but the drill did not pass. Do not trust this deployment yet.')

      console.log('\nRecovered.')
      console.log('Sign in at the panel. Set a new recovery passphrase if this one has been seen.')
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

recovery
  .command('show')
  .description('Open the snapshot and print what it holds. Never prints a secret value')
  .requiredOption('--endpoint <url>', 'S3 endpoint')
  .requiredOption('--bucket <bucket>', 'bucket name')
  .action(async (options: { endpoint: string; bucket: string }) => {
    const { fetchSnapshot } = await import('./backup/snapshot.js')
    const store = await recoveryStore(options.endpoint, options.bucket)
    const passphrase = await ask('Recovery passphrase: ')

    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const work = mkdtempSync(join(tmpdir(), 'qt-recover-'))
    try {
      const got = await fetchSnapshot(store, passphrase, join(work, 'state.enc'))
      if (!got.ok) fail(got.detail)
      const body = got.body!
      console.log(`taken          ${body.takenAt}`)
      console.log(`by engine      ${body.engineVersion}`)
      const state = body.state as { version?: string; enabled?: string[] }
      console.log(`app version    ${state.version ?? '(unknown)'}`)
      console.log(`modules        ${(state.enabled ?? []).join(', ') || '(none beyond required)'}`)
      // Names only. The whole point of the file is that the values are not
      // readable without the passphrase; printing them here would undo that on
      // whatever terminal this was typed into.
      console.log(`secrets        ${Object.keys(body.secrets).sort().join(', ')}`)
      console.log(`audit entries  ${body.audit.length}`)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

/** An S3 store built from values typed now, not from state this box does not have. */
async function recoveryStore(endpoint: string, bucket: string) {
  const { s3StoreFrom } = await import('./backup/store.js')
  const accessKeyId = await ask('S3 access key id: ')
  const secretAccessKey = await ask('S3 secret access key: ')
  if (!accessKeyId || !secretAccessKey) fail('Both keys are needed to read the store.')
  return s3StoreFrom({ endpoint, bucket, accessKeyId, secretAccessKey })
}

/**
 * Ask for one secret value, from a person or from a pipe.
 *
 * Both matter and they behave differently. Recovery is typed by someone at a
 * terminal on a bad day, and it is also run from a script over ssh — the
 * acceptance test for this phase is exactly that. A prompt that only works one
 * way is a prompt that fails in whichever case was not tried.
 *
 * Piped: stdin is drained once and handed out a line at a time, because
 * readline in terminal mode over a pipe echoed the first value and then stalled
 * on the second. Interactive: the echo is suppressed, so a key does not end up
 * in the scrollback of whoever was watching.
 */
let piped: string[] | undefined

async function ask(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    if (piped === undefined) {
      // Read once. Asking twice of a pipe gets nothing the second time.
      piped = readFileSync(0, 'utf8').split('\n')
    }
    const line = piped.shift()
    if (line === undefined) fail(`Nothing left on stdin for: ${prompt.trim()}`)
    return line!.trim()
  }

  process.stdout.write(prompt)
  const { createInterface } = await import('node:readline')
  /*
   * Echo is suppressed for the length of the answer. A recovery passphrase and
   * two store keys are exactly the values that should not be readable over a
   * shoulder or recoverable from a scrollback buffer. The mute sits on a
   * wrapper rather than on stdout itself, so the prompt above still prints.
   */
  let muted = false
  const muteable = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk as Buffer)
      callback()
    },
  })
  const rl = createInterface({ input: process.stdin, output: muteable, terminal: true })
  muted = true
  return new Promise((resolve) => {
    rl.question('', (answer) => {
      muted = false
      rl.close()
      process.stdout.write('\n')
      resolve(answer.trim())
    })
  })
}

// ---------------------------------------------------------------------------
// Who may sign in
// ---------------------------------------------------------------------------

/**
 * Sign-in is configured from a shell and only from a shell.
 *
 * Configuring a lock from behind the door it locks is how a deployment gets
 * locked out of itself: one wrong object id typed into a web form and the form
 * is unreachable. From here the worst case is that you are already standing
 * where the recovery would have to happen.
 *
 * This is also the bootstrap. A fresh box has no client secret, so it has no
 * panel — `secrets set ENTRA_CLIENT_SECRET` and `auth redirect` are what turn
 * one on, and reaching them already requires the machine.
 */
const auth = program.command('auth').description('Who may sign in to this panel')

auth
  .command('status')
  .description('Whether this deployment can be signed in to, and by whom')
  .action(async () => {
    const { loadState, loadSecrets } = await import('./state/store.js')
    const settings = loadState().settings
    const secretSet = Boolean(loadSecrets()['ENTRA_CLIENT_SECRET'])

    console.log(`tenant         ${settings.entraTenantId || '(not set)'}`)
    console.log(`client         ${settings.entraClientId || '(not set)'}`)
    console.log(`redirect       ${settings.entraRedirectUri || '(not set)'}`)
    console.log(`secret         ${secretSet ? 'stored' : '(not set)'}`)
    console.log(`allowed        ${settings.entraAllowedObjectIds.join(', ') || '(nobody)'}`)

    const missing: string[] = []
    if (!settings.entraTenantId) missing.push('a tenant id')
    if (!settings.entraClientId) missing.push('a client id')
    if (!settings.entraRedirectUri) missing.push('a redirect URI  (auth redirect <url>)')
    if (!secretSet) missing.push('a client secret  (secrets set ENTRA_CLIENT_SECRET)')
    if (settings.entraAllowedObjectIds.length === 0) missing.push('somebody on the allow-list  (auth allow <objectId>)')

    console.log(
      missing.length === 0
        ? '\nThe panel can be signed in to.'
        : `\nThe panel cannot be signed in to yet. Missing: ${missing.join('; ')}`,
    )
  })

auth
  .command('redirect <url>')
  .description('The callback URL registered with the Entra application')
  .action(async (url: string) => {
    const { loadState, saveState } = await import('./state/store.js')
    // Entra refuses plain http except on localhost, so a URI it will not accept
    // is refused here rather than at the first sign-in.
    if (!/^https:\/\//.test(url) && !/^http:\/\/localhost(:|\/)/.test(url)) {
      fail('The redirect URI must be https, or http://localhost. Entra refuses anything else.')
    }
    const state = loadState()
    saveState({ ...state, settings: { ...state.settings, entraRedirectUri: url } })
    console.log(`Redirect URI set to ${url}`)
    console.log('It must match one registered on the Entra application exactly.')
    // The same value decides which Host header the engine will answer to, so
    // say so — a 421 after a successful Microsoft sign-in points nowhere near
    // its cause, and this is the moment the connection is obvious.
    const host = new URL(url).hostname
    console.log(`\nThe panel will now also answer to the host name ${host}.`)
    console.log('Restart the engine for that to take effect:  self-update <this version>')
  })

auth
  .command('allow <objectId...>')
  .description('Replace the list of object ids permitted to sign in')
  .action(async (objectIds: string[]) => {
    const { loadState, saveState } = await import('./state/store.js')
    const allow = objectIds.filter((id) => id.trim() !== '')
    // An empty list admits nobody, which is the right failure and a miserable
    // way to learn it. Refused here, where the panel is still reachable.
    if (allow.length === 0) fail('At least one object id, or nobody can sign in.')
    const state = loadState()
    saveState({ ...state, settings: { ...state.settings, entraAllowedObjectIds: allow } })
    console.log(`Allowed: ${allow.join(', ')}`)
  })

auth
  .command('sign-out-everyone')
  .description('Destroy every session on this box')
  .action(async () => {
    const { AuthStore } = await import('./server/auth.js')
    new AuthStore().destroyAllSessions()
    // Entra stops new sign-ins the moment an account is disabled, but a session
    // already issued is a cookie on somebody's laptop and Microsoft has no say
    // in it. Revoking access means doing both; this is the half that is ours.
    console.log('Every session is gone. Entra decides who may start a new one.')
  })

// ---------------------------------------------------------------------------
// Deploying
// ---------------------------------------------------------------------------

program
  .command('render')
  .description('Render the compose file')
  .option('--stdout', 'print it instead of writing it')
  .action(async (options: { stdout?: boolean }) => {
    const plan = await requirePlan()
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
    const plan = await requirePlan()
    const path = writePlan(plan.yaml)
    console.log(`Wrote ${path}`)

    const valid = await docker.validate()
    if (valid.code !== 0) {
      console.error('Docker refused the generated file. This is an engine bug, not your config:')
      console.error(valid.stderr.trim())
      process.exit(1)
    }

    /*
     * Log the daemon in before anything reaches the registry.
     *
     * The web path does this (server/jobs.ts) and this one did not, so an
     * apply from the command line worked only while a login happened to be
     * left in the engine container's filesystem. Replacing the container --
     * which `self-update` does -- wipes that, and the next apply fails
     * `unauthorized` even though every image is public to the host's own
     * docker. Both paths now stand on the stored credential rather than on a
     * side effect of whatever was run before.
     */
    const { REGISTRY, storedRegistryAuth } = await import('./registry.js')
    const auth = storedRegistryAuth()
    if (auth) {
      const loggedIn = await docker.login(REGISTRY, auth.username, auth.token)
      if (loggedIn.code !== 0) {
        console.error('The registry refused the stored credential. Nothing has been touched.')
        console.error(loggedIn.stderr.trim())
        process.exit(1)
      }
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

    /*
     * Back up before touching anything running -- the same rule the web path
     * has had since it was written, and the same asymmetry this command
     * already had once and fixed for the registry login a few lines up.
     *
     * It mattered more than an inconsistency. `apply` runs
     * `prisma migrate deploy` against live data, which is the highest-risk
     * moment a deployment has, and the application repository's CLAUDE.md
     * told everyone "apply does not take a backup, take one by hand" -- so
     * whether a firm's database was protected during a migration depended on
     * whether the person deploying had read a paragraph in another repository
     * and remembered it.
     *
     * A failed backup aborts exactly like a failed pull: nothing running has
     * been touched. The exception is the first deploy, where there is no
     * database yet and nothing to protect.
     */
    const { listBackups, takeBackup } = await import('./backup/service.js')
    if (listBackups().length > 0) {
      console.log('Backing up before touching anything…')
      const backup = await takeBackup('pre-update')
      console.log(backup.detail)
      if (!backup.ok) {
        console.error('Deploy stopped. Nothing running has been touched.')
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
  .command('serve')
  .description('Run the web interface')
  .option('-p, --port <port>', 'port to listen on', '8080')
  .action(async (options: { port: string }) => {
    const { startServer } = await import('./server/index.js')
    await startServer(Number(options.port) || 8080)
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

async function requirePlan(): Promise<{ yaml: string; moduleIds: readonly string[] }> {
  const plan = await buildPlan()
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

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { readLastDrill } from '../../backup/drill.js'
import { offsiteClient, probeOffsite, readOffsite } from '../../backup/offsite.js'
import { listBackups } from '../../backup/service.js'
import { RECOVERY_PASSPHRASE, SNAPSHOT_KEY, clearKeyCache, readSnapshotMarker } from '../../backup/snapshot.js'
import { loadSecrets, loadState, saveSecrets, saveState } from '../../state/store.js'
import type { ServerContext } from '../context.js'
import { refuse } from '../guards.js'

export const S3_ACCESS_KEY_ID = 'S3_ACCESS_KEY_ID'
export const S3_SECRET_ACCESS_KEY = 'S3_SECRET_ACCESS_KEY'

/*
 * Endpoint: https only, no path. R2's is `https://<account>.<region>.r2.cloudflarestorage.com`.
 * A trailing slash is stripped rather than refused, as `offsite use-s3` does.
 */
const offsitePatch = z.object({
  enabled: z.boolean(),
  endpoint: z.string().trim().max(300).optional(),
  bucket: z.string().trim().max(200).optional(),
  region: z.string().trim().max(50).optional(),
  prefix: z.string().trim().max(200).optional(),
  accessKeyId: z.string().max(500).optional(),
  secretAccessKey: z.string().max(500).optional(),
})

const passphraseBody = z.object({ passphrase: z.string().max(1000) })

/**
 * Offsite storage and recovery over the API — the panel's side of
 * `offsite status/use-s3/test`, `recovery status/passphrase`.
 *
 * Nothing here reads a secret back. The keys and the passphrase are written
 * and reported as set or not; the value has no read path, as everywhere else.
 */
export function recoveryRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/offsite', async () => {
    const settings = loadState(ctx.dir).settings
    const secrets = loadSecrets(ctx.dir)
    const { client, reason } = offsiteClient(ctx.dir)
    const sets = listBackups(ctx.dir)
    const waiting = settings.backupOffsiteEnabled ? sets.filter((set) => !readOffsite(set.id, ctx.dir).uploadedAt) : []
    return {
      success: true,
      data: {
        enabled: settings.backupOffsiteEnabled,
        endpoint: settings.backupS3Endpoint,
        bucket: settings.backupS3Bucket,
        region: settings.backupS3Region,
        prefix: settings.backupS3Prefix,
        keys: {
          accessKeyId: Boolean(secrets[S3_ACCESS_KEY_ID]),
          secretAccessKey: Boolean(secrets[S3_SECRET_ACCESS_KEY]),
        },
        ready: client !== null,
        reason: client === null && reason !== 'off' ? reason : null,
        label: client?.label ?? null,
        sets: sets.length,
        pending: waiting.length,
        oldestPending: waiting.at(-1)?.id ?? null,
      },
    }
  })

  app.put('/api/offsite', async (request, reply) => {
    const body = offsitePatch.safeParse(request.body)
    if (!body.success) return refuse(reply, 400, 'Those offsite settings are not valid.')
    const patch = body.data

    const secrets = loadSecrets(ctx.dir)
    const next = { ...secrets }
    if (patch.accessKeyId) next[S3_ACCESS_KEY_ID] = patch.accessKeyId
    if (patch.secretAccessKey) next[S3_SECRET_ACCESS_KEY] = patch.secretAccessKey

    const state = loadState(ctx.dir)
    const endpoint = (patch.endpoint ?? state.settings.backupS3Endpoint).replace(/\/$/, '')
    const bucket = patch.bucket ?? state.settings.backupS3Bucket

    if (patch.enabled) {
      if (!/^https:\/\/[^/\s]+$/.test(endpoint)) {
        return refuse(reply, 400, 'The endpoint must be an https URL with no path, e.g. https://<account>.r2.cloudflarestorage.com.')
      }
      if (!bucket) return refuse(reply, 400, 'A bucket name is required.')
      if (!next[S3_ACCESS_KEY_ID] || !next[S3_SECRET_ACCESS_KEY]) {
        return refuse(reply, 400, 'Both keys are needed before offsite can be turned on.')
      }
    }

    if (next !== secrets && (patch.accessKeyId || patch.secretAccessKey)) saveSecrets(next, ctx.dir)
    saveState(
      {
        ...state,
        settings: {
          ...state.settings,
          backupOffsiteEnabled: patch.enabled,
          backupS3Endpoint: endpoint,
          backupS3Bucket: bucket,
          backupS3Region: patch.region || state.settings.backupS3Region || 'auto',
          backupS3Prefix: patch.prefix ?? state.settings.backupS3Prefix,
        },
      },
      ctx.dir,
    )
    ctx.audit.record('offsite-changed', {
      detail: patch.enabled ? `${bucket} at ${endpoint}` : 'turned off',
      address: request.ip,
      ...(request.operator ? { subject: request.operator.upn || request.operator.oid } : {}),
    })
    return { success: true, data: {} }
  })

  app.post('/api/offsite/test', async (_request, reply) => {
    const { client, reason } = offsiteClient(ctx.dir)
    if (!client) return refuse(reply, 409, reason === 'off' ? 'Offsite is off.' : `Offsite is not usable: ${reason}`)
    const result = await probeOffsite(client)
    return { success: true, data: result }
  })

  app.get('/api/recovery', async () => {
    const secrets = loadSecrets(ctx.dir)
    const marker = readSnapshotMarker(ctx.dir)
    const { client } = offsiteClient(ctx.dir)
    let inStore: { size: number } | null | undefined
    if (client) {
      try {
        const found = await client.stat(SNAPSHOT_KEY)
        inStore = found ? { size: found.size } : null
      } catch {
        inStore = undefined
      }
    }
    return {
      success: true,
      data: {
        passphraseSet: Boolean(secrets[RECOVERY_PASSPHRASE]),
        snapshot: {
          uploadedAt: marker.uploadedAt ?? null,
          verifiedAt: marker.verifiedAt ?? null,
          /** What the store said just now: present, absent, or (undefined) unreachable. */
          inStore: inStore === undefined ? null : inStore !== null,
          bytes: inStore?.size ?? null,
          key: SNAPSHOT_KEY,
        },
        store: client ? { label: client.label } : null,
        lastDrill: readLastDrill(ctx.dir) ?? null,
      },
    }
  })

  app.put('/api/recovery/passphrase', async (request, reply) => {
    const body = passphraseBody.safeParse(request.body)
    if (!body.success) return refuse(reply, 400, 'A passphrase is required.')
    const passphrase = body.data.passphrase.trim()
    if (passphrase.length < 12) {
      return refuse(reply, 400, 'Too short. This is the only thing standing between a bucket and every credential this deployment holds; twelve characters at least.')
    }
    const secrets = loadSecrets(ctx.dir)
    const replacing = Boolean(secrets[RECOVERY_PASSPHRASE])
    saveSecrets({ ...secrets, [RECOVERY_PASSPHRASE]: passphrase }, ctx.dir)
    clearKeyCache()
    ctx.audit.record('recovery-passphrase-set', {
      detail: replacing ? 'replaced' : 'set',
      address: request.ip,
      ...(request.operator ? { subject: request.operator.upn || request.operator.oid } : {}),
    })
    return { success: true, data: { replacing } }
  })
}

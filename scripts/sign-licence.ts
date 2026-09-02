/**
 * Issue a licence — OUR tool, not the firm's.
 *
 * This stays a development script until the licence service exists; it is the
 * only place in this repository that touches a private key, and the key it
 * touches is read from a path outside the repository, never committed.
 *
 *   npx tsx scripts/sign-licence.ts keygen > keypair.json
 *   npx tsx scripts/sign-licence.ts sign keypair.json claims.json
 *
 * claims.json needs: firmId, firmName, expiresAt, entitlements, seats,
 * heartbeat.url. The rest is defaulted here.
 */
import { createPrivateKey, generateKeyPairSync, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { licenceClaimsSchema, signLicence, LICENCE_VERSION } from '../src/licence/format.js'

const [mode, ...args] = process.argv.slice(2)

if (mode === 'keygen') {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  console.log(
    JSON.stringify(
      {
        privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
        publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
      },
      null,
      2,
    ),
  )
} else if (mode === 'sign') {
  const [keyPath, claimsPath] = args
  if (!keyPath || !claimsPath) {
    console.error('Usage: sign-licence.ts sign <keypair.json> <claims.json>')
    process.exit(1)
  }
  const keypair = JSON.parse(readFileSync(keyPath, 'utf8')) as { privateKeyPem: string }
  const supplied = JSON.parse(readFileSync(claimsPath, 'utf8')) as Record<string, unknown>

  const claims = licenceClaimsSchema.parse({
    v: LICENCE_VERSION,
    licenceId: randomUUID(),
    issuedAt: new Date().toISOString(),
    override: false,
    ...supplied,
    heartbeat: {
      intervalHours: 24,
      graceDays: 30,
      ...(supplied['heartbeat'] as object),
    },
  })
  const token = await signLicence(claims, createPrivateKey(keypair.privateKeyPem))
  console.log(token)
} else {
  console.error('Usage: sign-licence.ts keygen | sign <keypair.json> <claims.json>')
  process.exit(1)
}

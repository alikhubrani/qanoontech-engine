import { describe, expect, it } from 'vitest'
import { CATALOGUE, REQUIRED_MODULE_IDS, resolve } from './index.js'

const ALL = CATALOGUE.map((m) => m.entitlement).filter((e): e is string => e !== undefined)

const base = { enabled: [] as string[], config: {} as Record<string, unknown>, entitlements: ALL }

describe('resolve', () => {
  it('includes the required modules even when nothing was asked for', () => {
    const result = resolve(base)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const ids = result.modules.map((m) => m.module.id)
    for (const required of REQUIRED_MODULE_IDS) expect(ids).toContain(required)
  })

  it('orders dependencies before the modules that need them', () => {
    const result = resolve({ ...base, enabled: ['drive-mirror'], config: { 'drive-mirror': { sharedDriveId: 'abc' } } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const ids = result.modules.map((m) => m.module.id)
    expect(ids.indexOf('postgres')).toBeLessThan(ids.indexOf('app'))
    expect(ids.indexOf('app')).toBeLessThan(ids.indexOf('nginx'))
    expect(ids.indexOf('app')).toBeLessThan(ids.indexOf('drive-mirror'))
  })

  it('refuses a module the catalogue does not define', () => {
    const result = resolve({ ...base, enabled: ['nextcloud'] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems.some((p) => p.code === 'unknown-module')).toBe(true)
  })

  it('refuses an optional module the licence does not entitle', () => {
    const result = resolve({
      ...base,
      enabled: ['drive-mirror'],
      config: { 'drive-mirror': { sharedDriveId: 'abc' } },
      entitlements: [],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    const problem = result.problems.find((p) => p.code === 'missing-entitlement')
    expect(problem?.moduleId).toBe('drive-mirror')
  })

  it('deploys the system itself without any entitlement', () => {
    // A licensed deployment is entitled to the system; the licence gates what
    // is *added* to it. If this ever fails, an expired licence stops being an
    // enforcement decision and starts being an inability to render at all.
    const result = resolve({ ...base, entitlements: [] })
    expect(result.ok).toBe(true)
  })

  it('applies a module’s configuration defaults', () => {
    const result = resolve({ ...base, enabled: ['drive-mirror'], config: { 'drive-mirror': { sharedDriveId: 'abc' } } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const mirror = result.modules.find((m) => m.module.id === 'drive-mirror')
    // Only the id was given; the size limit is the schema's default.
    expect(mirror?.config).toEqual({ sharedDriveId: 'abc', maxFileSizeBytes: 1_073_741_824 })
  })

  it('refuses configuration that does not match the schema', () => {
    const result = resolve({
      ...base,
      enabled: ['drive-mirror'],
      config: { 'drive-mirror': { sharedDriveId: '' } },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems.some((p) => p.code === 'invalid-config')).toBe(true)
  })

  it('collects every problem rather than stopping at the first', () => {
    const result = resolve({
      ...base,
      enabled: ['email', 'drive-mirror', 'nonsense'],
      config: { 'drive-mirror': {} },
      entitlements: [],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems.length).toBeGreaterThan(1)
  })
})

describe('the catalogue itself', () => {
  it('gives every module a unique id', () => {
    const ids = CATALOGUE.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('declares dependencies that exist', () => {
    const ids = new Set(CATALOGUE.map((m) => m.id))
    for (const module of CATALOGUE) {
      for (const dependency of module.requires) expect(ids).toContain(dependency)
    }
  })

  it('entitles every optional module and no required one', () => {
    for (const module of CATALOGUE) {
      if (module.required) expect(module.entitlement).toBeUndefined()
      else expect(module.entitlement).toBeTruthy()
    }
  })

  it('never defaults an optional module to on', () => {
    // Off by default is the rule: a module nobody has committed to should not
    // be costing a firm two gigabytes because it shipped enabled.
    for (const module of CATALOGUE) {
      if (!module.required) expect(module.defaultEnabled).toBe(false)
    }
  })
})

describe('configuration a module does not require', () => {
  it('lets a module with no mandatory settings be enabled with none supplied', () => {
    // A module whose fields all have defaults must accept `undefined`, or
    // turning it on and not configuring it reads as a validation failure. In
    // zod that means a top-level prefault; it is easy to leave off, and the
    // symptom is a module that cannot be enabled at all.
    for (const module of CATALOGUE) {
      const withNothing = module.config.safeParse(undefined)
      const withEmptyObject = module.config.safeParse({})
      if (withEmptyObject.success) {
        expect(
          withNothing.success,
          `'${module.id}' accepts {} but refuses no configuration at all — it needs a top-level prefault`,
        ).toBe(true)
      }
    }
  })
})

describe('the email module', () => {
  const email = CATALOGUE.find((m) => m.id === 'email')!
  const configured = { smtpHost: 'smtp.example.com', fromAddress: 'noreply@example.com' }

  it('needs its own entitlement, like every optional module', () => {
    const result = resolve({ ...base, enabled: ['email'], config: { email: configured }, entitlements: [] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    const problem = result.problems.find((p) => p.code === 'missing-entitlement')
    expect(problem?.moduleId).toBe('email')
  })

  it('needs a host and a sender, and nothing else', () => {
    expect(email.config.safeParse({}).success).toBe(false)
    expect(email.config.safeParse({ smtpHost: 'smtp.example.com' }).success).toBe(false)
    expect(email.config.safeParse({ fromAddress: 'noreply@example.com' }).success).toBe(false)
    expect(email.config.safeParse(configured).success).toBe(true)
  })

  it('applies the STARTTLS defaults', () => {
    const result = resolve({ ...base, enabled: ['email'], config: { email: configured } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const module = result.modules.find((m) => m.module.id === 'email')
    expect(module?.config).toEqual({ ...configured, smtpPort: 587, smtpSecure: false })
  })

  it('insists the sender is an email address', () => {
    expect(email.config.safeParse({ ...configured, fromAddress: 'not an address' }).success).toBe(false)
  })

  it('declares the SMTP password as an optional secret', () => {
    // A relay that takes no credentials needs no password, and the renderer
    // must not refuse one over a secret it never asks for.
    const secret = email.secrets.find((s) => s.name === 'SMTP_PASSWORD')
    expect(secret?.optional).toBe(true)
    expect(secret?.kind).toBe('token')
  })

  it('reads the application database and no volume', () => {
    expect(email.requires).toEqual(['app', 'postgres'])
    expect(email.volumes).toEqual([])
  })
})

describe('a module turned on but never configured', () => {
  it('is told it needs configuring, not that an object was expected', () => {
    const result = resolve({ ...base, enabled: ['drive-mirror'] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    const problem = result.problems.find((p) => p.moduleId === 'drive-mirror')
    expect(problem?.message).toContain('has not been configured')
    expect(problem?.message).not.toContain('expected object')
  })
})

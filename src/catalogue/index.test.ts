import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { CATALOGUE, REQUIRED_MODULE_IDS, resolve } from './index.js'

const ALL = CATALOGUE.map((m) => m.entitlement).filter((e): e is string => e !== undefined)

const base = { enabled: [] as string[], config: {} as Record<string, unknown>, entitlements: ALL }

/**
 * The optional module these tests exercise resolution with: not required, so
 * it can be absent; entitled, so the licence can refuse it; and carrying both
 * mandatory configuration and defaults, so an invalid form and an incomplete
 * one are different failures. This used to be the Drive mirror, which was
 * retired with Google Drive.
 */
const VALID_EMAIL = { smtpHost: 'smtp.example.com', fromAddress: 'firm@example.com' }

describe('resolve', () => {
  it('includes the required modules even when nothing was asked for', () => {
    const result = resolve(base)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const ids = result.modules.map((m) => m.module.id)
    for (const required of REQUIRED_MODULE_IDS) expect(ids).toContain(required)
  })

  it('orders dependencies before the modules that need them', () => {
    const result = resolve({ ...base, enabled: ['email'], config: { email: VALID_EMAIL } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const ids = result.modules.map((m) => m.module.id)
    expect(ids.indexOf('postgres')).toBeLessThan(ids.indexOf('app'))
    expect(ids.indexOf('app')).toBeLessThan(ids.indexOf('nginx'))
    expect(ids.indexOf('app')).toBeLessThan(ids.indexOf('email'))
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
      enabled: ['email'],
      config: { email: VALID_EMAIL },
      entitlements: [],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    const problem = result.problems.find((p) => p.code === 'missing-entitlement')
    expect(problem?.moduleId).toBe('email')
  })

  it('deploys the system itself without any entitlement', () => {
    // A licensed deployment is entitled to the system; the licence gates what
    // is *added* to it. If this ever fails, an expired licence stops being an
    // enforcement decision and starts being an inability to render at all.
    const result = resolve({ ...base, entitlements: [] })
    expect(result.ok).toBe(true)
  })

  it('applies a module’s configuration defaults', () => {
    const result = resolve({ ...base, enabled: ['email'], config: { email: VALID_EMAIL } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const mailer = result.modules.find((m) => m.module.id === 'email')
    // Only the host and the sender were given; the port, the TLS mode and the
    // authentication mode are the schema's defaults.
    expect(mailer?.config).toEqual({
      ...VALID_EMAIL,
      smtpPort: 587,
      smtpSecure: false,
      authMode: 'basic',
    })
  })

  it('refuses configuration that does not match the schema', () => {
    const result = resolve({
      ...base,
      enabled: ['email'],
      config: { email: { ...VALID_EMAIL, smtpHost: '' } },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems.some((p) => p.code === 'invalid-config')).toBe(true)
  })

  it('collects every problem rather than stopping at the first', () => {
    const result = resolve({
      ...base,
      enabled: ['email', 'tunnel', 'nonsense'],
      config: { email: {} },
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
    expect(module?.config).toEqual({ ...configured, smtpPort: 587, smtpSecure: false, authMode: 'basic' })
  })

  it('insists the sender is an email address', () => {
    expect(email.config.safeParse({ ...configured, fromAddress: 'not an address' }).success).toBe(false)
  })

  it('demands the Microsoft settings when the mode is Microsoft OAuth', () => {
    // Refused here, rather than discovered by a mailer that boots unhealthy
    // and answers /health with a list of what it was not told.
    const partial = email.config.safeParse({ ...configured, authMode: 'oauth-microsoft' })
    expect(partial.success).toBe(false)
    if (!partial.success) {
      const paths = partial.error.issues.map((i) => i.path.join('.')).sort()
      expect(paths).toEqual(['oauthClientId', 'oauthTenantId', 'smtpUser'])
    }

    expect(
      email.config.safeParse({
        ...configured,
        authMode: 'oauth-microsoft',
        smtpUser: 'notify@example.com',
        oauthTenantId: '00000000-0000-0000-0000-000000000000',
        oauthClientId: '11111111-1111-1111-1111-111111111111',
      }).success
    ).toBe(true)
  })

  it('renders a form, which a discriminated union would not', () => {
    // The Deploy page walks schema.properties; `anyOf` draws as nothing at
    // all. This is the test that fails if someone tidies the schema into the
    // union it looks like it wants to be.
    const schema = z.toJSONSchema(email.config, { io: 'input' }) as {
      properties?: Record<string, { enum?: string[] }>
    }
    expect(Object.keys(schema.properties ?? {})).toContain('authMode')
    expect(schema.properties?.authMode?.enum).toEqual(['basic', 'oauth-microsoft'])
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
    const result = resolve({ ...base, enabled: ['email'] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    const problem = result.problems.find((p) => p.moduleId === 'email')
    expect(problem?.message).toContain('has not been configured')
    expect(problem?.message).not.toContain('expected object')
  })
})

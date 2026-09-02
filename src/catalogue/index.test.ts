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
    const result = resolve({ ...base, enabled: ['ocr'], config: {} })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const ids = result.modules.map((m) => m.module.id)
    expect(ids.indexOf('postgres')).toBeLessThan(ids.indexOf('app'))
    expect(ids.indexOf('app')).toBeLessThan(ids.indexOf('nginx'))
    expect(ids.indexOf('app')).toBeLessThan(ids.indexOf('ocr'))
  })

  it('refuses a module the catalogue does not define', () => {
    const result = resolve({ ...base, enabled: ['nextcloud'] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems.some((p) => p.code === 'unknown-module')).toBe(true)
  })

  it('refuses an optional module the licence does not entitle', () => {
    const result = resolve({ ...base, enabled: ['ocr'], entitlements: [] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    const problem = result.problems.find((p) => p.code === 'missing-entitlement')
    expect(problem?.moduleId).toBe('ocr')
  })

  it('deploys the system itself without any entitlement', () => {
    // A licensed deployment is entitled to the system; the licence gates what
    // is *added* to it. If this ever fails, an expired licence stops being an
    // enforcement decision and starts being an inability to render at all.
    const result = resolve({ ...base, entitlements: [] })
    expect(result.ok).toBe(true)
  })

  it('applies a module’s configuration defaults', () => {
    const result = resolve({ ...base, enabled: ['ocr'] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const ocr = result.modules.find((m) => m.module.id === 'ocr')
    expect(ocr?.config).toEqual({ languages: ['ar', 'en'], maxConcurrency: 1 })
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
      enabled: ['ocr', 'drive-mirror', 'nonsense'],
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

import { describe, expect, it } from 'vitest'
import { loggedUrl } from './log-url.js'

describe('the request line', () => {
  it('keeps the sign-in code out of the log', () => {
    expect(loggedUrl('/api/session/entra/callback?code=1.AXoABi&state=RLCD&session_state=008a')).toBe(
      '/api/session/entra/callback?…',
    )
  })

  it('leaves every other query alone, because a filter is worth seeing', () => {
    expect(loggedUrl('/api/audit?limit=50&kinds=failure')).toBe('/api/audit?limit=50&kinds=failure')
    expect(loggedUrl('/api/session/entra/callback')).toBe('/api/session/entra/callback')
  })
})

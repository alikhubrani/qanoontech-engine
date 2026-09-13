import { describe, expect, it } from 'vitest'
import { uploadsWriteScript } from './index.js'

/**
 * Every documents helper runs as root and used to leave root's files behind.
 * The fix is one appended `chown`, and this is the whole of its contract:
 * present when an owner is known, absent when it is not, and never built from
 * anything that is not a uid:gid — it goes into `sh -c`.
 */
describe('writing documents onto the volume', () => {
  it('hands ownership to the application after the copy', () => {
    expect(uploadsWriteScript('cp -a /state/x/. /uploads/', '1001:65533'))
      .toBe('cp -a /state/x/. /uploads/ && chown -R 1001:65533 /uploads')
  })

  it('copies without a chown when the owner is not known, rather than failing', () => {
    // A restore that cannot ask the image still restores; it says so instead.
    expect(uploadsWriteScript('tar xzf /state/a.tgz -C /uploads', undefined))
      .toBe('tar xzf /state/a.tgz -C /uploads')
  })

  it('refuses an owner that is not two numbers', () => {
    // The owner is interpolated into a shell command. This is the only shape
    // it may have.
    for (const bad of ['nextjs:nodejs', '1001', '1001:65533; rm -rf /', '', ' 1001:1 ']) {
      expect(() => uploadsWriteScript('cp', bad), bad).toThrow()
    }
  })
})

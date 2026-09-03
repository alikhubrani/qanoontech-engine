import { describe, expect, it } from 'vitest'
import { ImagePullTracker } from './pull.js'

describe('the pull progress reducer', () => {
  it('sums bytes across layers and knows the total once sizes arrive', () => {
    const t = new ImagePullTracker()
    t.apply({ id: 'a', status: 'Downloading', progressDetail: { current: 100, total: 400 } })
    t.apply({ id: 'b', status: 'Downloading', progressDetail: { current: 50, total: 600 } })
    expect(t.downloaded()).toBe(150)
    expect(t.total()).toBe(1000)
  })

  it('advances a layer, not double-counts it', () => {
    const t = new ImagePullTracker()
    t.apply({ id: 'a', status: 'Downloading', progressDetail: { current: 100, total: 400 } })
    t.apply({ id: 'a', status: 'Downloading', progressDetail: { current: 300, total: 400 } })
    expect(t.downloaded()).toBe(300)
    expect(t.total()).toBe(400)
  })

  it('completes a layer to its full size on Pull complete', () => {
    const t = new ImagePullTracker()
    t.apply({ id: 'a', status: 'Downloading', progressDetail: { current: 100, total: 400 } })
    t.apply({ id: 'a', status: 'Pull complete' })
    expect(t.downloaded()).toBe(400)
  })

  it('counts an already-present layer as done without a size', () => {
    const t = new ImagePullTracker()
    t.apply({ id: 'a', status: 'Already exists' })
    // No bytes, but it should not block "extracting" once real layers finish.
    expect(t.downloaded()).toBe(0)
  })

  it('reports extracting when every sized layer is fully downloaded', () => {
    const t = new ImagePullTracker()
    t.apply({ id: 'a', status: 'Downloading', progressDetail: { current: 400, total: 400 } })
    t.apply({ id: 'b', status: 'Downloading', progressDetail: { current: 200, total: 200 } })
    expect(t.extracting()).toBe(true)
  })

  it('is not extracting while a sized layer is still short', () => {
    const t = new ImagePullTracker()
    t.apply({ id: 'a', status: 'Downloading', progressDetail: { current: 400, total: 400 } })
    t.apply({ id: 'b', status: 'Downloading', progressDetail: { current: 10, total: 200 } })
    expect(t.extracting()).toBe(false)
  })
})

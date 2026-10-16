import { describe, expect, it } from 'vitest'
import { previewState } from './preview-state'

describe('native visual preview', () => {
  it('accepts only named local orb states as launch arguments', () => {
    expect(previewState(['electron', '.', '--state=speaking'])).toBe('speaking')
    expect(previewState(['electron', '.', '--state=thinking'])).toBe('thinking')
    expect(previewState(['electron', '.', '--state=https://example.com'])).toBeUndefined()
    expect(previewState(['electron', '.'])).toBeUndefined()
  })
})
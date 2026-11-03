import { describe, expect, it } from 'vitest'
import { FILE_LIMITS, sniffFile } from '../../shared/files.ts'
import { fitWithin, uploadPlan } from '../../src/lib/postImage.ts'

/** A post's picture (e13-t13): what the browser does before uploading, and what the Worker reads of the bytes */

describe('post pictures (e13-t13)', () => {
  it('shrinks to the long side, never enlarging', () => {
    expect(fitWithin({ width: 4096, height: 3072 }, FILE_LIMITS.pixels)).toEqual({ width: 2048, height: 1536 })
    expect(fitWithin({ width: 1000, height: 3000 }, 480)).toEqual({ width: 160, height: 480 })
    expect(fitWithin({ width: 300, height: 200 }, 2048)).toEqual({ width: 300, height: 200 })
  })

  it('redraws photos, keeps a GIF that fits, and turns down the rest', () => {
    expect(uploadPlan({ type: 'image/jpeg', size: 9_000_000 })).toBe('redraw')
    expect(uploadPlan({ type: 'image/png', size: 10 })).toBe('redraw')
    expect(uploadPlan({ type: 'image/gif', size: FILE_LIMITS.maxBytes })).toBe('asIs')
    expect(uploadPlan({ type: 'image/gif', size: FILE_LIMITS.maxBytes + 1 })).toBe('tooLarge')
    expect(uploadPlan({ type: 'image/svg+xml', size: 10 })).toBe('badType')
    expect(uploadPlan({ type: 'image/heic', size: 10 })).toBe('badType')
  })

  it('reads the type from the first bytes only', () => {
    const bytes = (...b: number[]) => new Uint8Array([...b, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(sniffFile(bytes(0x47, 0x49, 0x46, 0x38, 0x37, 0x61))).toBe('image/gif')
    expect(sniffFile(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe('image/gif')
    expect(sniffFile(bytes(0xff, 0xd8, 0xff))).toBe('image/jpeg')
    expect(sniffFile(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(sniffFile(new TextEncoder().encode('GIF8'))).toBeNull()
  })
})

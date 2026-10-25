import { describe, expect, it } from 'vitest'
import { buildReport } from '../../src/lib/errorReport.ts'

describe('browser error reports (e11-t09)', () => {
  it('builds a report without personal data', () => {
    const error = new TypeError('cannot read amy@example.com 20261025123')
    const report = buildReport('error', error, '/table/abc', 'abc123', 'https://x.example/app.js?v=9:1:2')
    expect(report).toMatchObject({
      kind: 'error',
      message: 'TypeError: cannot read <email> <n>',
      page: '/table/abc',
      version: 'abc123',
      source: 'https://x.example/app.js',
    })
    expect(report?.stack).toBeTypeOf('string')
  })

  it('takes a string rejection reason and skips empty ones', () => {
    expect(buildReport('rejection', 'network down', '/', 'v')).toEqual({ kind: 'rejection', message: 'network down', page: '/', version: 'v' })
    expect(buildReport('rejection', undefined, '/', 'v')).toBeNull()
    expect(buildReport('rejection', { some: 'object' }, '/', 'v')).toBeNull()
  })
})

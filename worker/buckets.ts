/**
 * A club's own part of an R2 bucket (e12-t03): every key it puts, reads, lists or deletes starts
 * with `prefix` (shared/clubs.ts `clubStoragePrefix`), and the keys it is given back have it taken
 * off, so the backups (worker/backup.ts) and the files (worker/files.ts) work exactly as with a
 * bucket of their own. 淡江's prefix is empty: it gets the bucket itself, keys as they always were.
 * A club cannot reach outside its prefix: a key is only ever added to, never taken as it comes.
 */

/** The R2 calls the backups and files make; an `R2Bucket` has all of them */
export interface PrefixableBucket {
  put(key: string, value: never, options?: never): Promise<unknown>
  get(key: string): Promise<unknown>
  delete(keys: string | string[]): Promise<void>
  list?(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    objects: { key: string; size: number; uploaded: Date }[]
    truncated: boolean
    cursor?: string
  }>
}

export function scopedBucket<B extends PrefixableBucket>(bucket: B, prefix: string): B {
  if (!prefix) return bucket
  const scoped = {
    put: (key: string, value: never, options?: never) => bucket.put(`${prefix}${key}`, value, options),
    get: (key: string) => bucket.get(`${prefix}${key}`),
    delete: (keys: string | string[]) => bucket.delete(typeof keys === 'string' ? `${prefix}${keys}` : keys.map((key) => `${prefix}${key}`)),
    list: async (options: { prefix?: string; cursor?: string; limit?: number } = {}) => {
      if (!bucket.list) throw new Error('This bucket cannot list')
      const page = await bucket.list({ ...options, prefix: `${prefix}${options.prefix ?? ''}` })
      // Only the fields the backups read: an R2 object's own may be getters a spread would drop
      const objects = page.objects.map((o) => ({ key: o.key.slice(prefix.length), size: o.size, uploaded: o.uploaded }))
      return { objects, truncated: page.truncated, ...(page.cursor !== undefined && { cursor: page.cursor }) }
    },
  }
  return scoped as unknown as B
}

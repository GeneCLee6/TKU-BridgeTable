// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import type { PostBlock } from '../../shared/forum.ts'
import type { Me } from '../../shared/protocol.ts'
import { type FileBucket, FileService } from '../../worker/files.ts'
import { ForumService, postImageKeys } from '../../worker/forum.ts'
import { addedImageKeys, checkImagesOwned, droppedImageKeys, releaseImages, signFiles } from '../../worker/post-images.ts'
import { MemoryStore } from '../../worker/store.ts'
import { memorySql } from './sqlite.ts'

/** Forum pictures (e13-t13): whose they are, who gets their addresses, and that they go with their post */

class MemoryBucket implements FileBucket {
  readonly objects = new Map<string, Uint8Array>()
  async put(key: string, value: ArrayBuffer | Uint8Array) {
    this.objects.set(key, new Uint8Array(value))
  }
  async get(key: string) {
    const bytes = this.objects.get(key)
    return bytes ? { body: new Blob([bytes as Uint8Array<ArrayBuffer>]).stream(), size: bytes.length } : null
  }
  async delete(keys: string | string[]) {
    for (const key of [keys].flat()) this.objects.delete(key)
  }
}

const me = (id: string, permissions: Me['permissions'] = []): Me => ({ id, username: id, admin: false, permissions })
const amy = me('amy')
const ben = me('ben')
const officer = me('cat', ['forumModerate'])

const webp = () => {
  const bytes = new Uint8Array(64)
  bytes.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
  return bytes
}

const code = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return (error as { code?: string }).code
  }
  return 'no error'
}

let time: number
let ids: number
let forum: ForumService
let files: FileService
let bucket: MemoryBucket

beforeEach(() => {
  time = Date.parse('2026-11-03T04:00:00Z')
  ids = 0
  forum = new ForumService(memorySql(), { now: () => time, newId: () => `p${++ids}`, members: () => [] })
  forum.createTables()
  bucket = new MemoryBucket()
  files = new FileService(new MemoryStore(), bucket, () => time)
})

const upload = async (who: Me) => {
  const ticket = await files.createTicket(who.id, { purpose: 'post', type: 'image/webp', size: 64 })
  await files.upload(ticket.uploadUrl.split('/').pop()!, 'file', webp())
  return ticket.key
}
const image = (assetId: string): PostBlock => ({ kind: 'image', assetId, alt: '' })
const post = (who: Me, blocks: PostBlock[]) => {
  time += 60_000
  return forum.createPost(who, 'deals', { blocks })
}
const signed = async (viewer: Me, keys: string[]) => Object.keys((await signFiles(files, forum, viewer, keys)).urls).sort()

describe('forum pictures (e13-t13)', () => {
  it('lets a post add only pictures its author uploaded', async () => {
    const mine = await upload(amy)
    const theirs = await upload(ben)
    await checkImagesOwned(files, amy.id, addedImageKeys({ blocks: [image(mine)] }))
    expect(await code(checkImagesOwned(files, amy.id, addedImageKeys({ blocks: [image(theirs)] })))).toBe('forumImageNotYours')
    // A key with no file (never uploaded, or deleted) is refused too
    expect(await code(checkImagesOwned(files, amy.id, ['post/000000000000000000000000.webp']))).toBe('forumImageNotYours')
    // Editing: the pictures already in the post are not checked again
    expect(addedImageKeys({ blocks: [image(theirs), image(mine)] }, [image(theirs)])).toEqual([mine])
    expect(addedImageKeys({ blocks: 'nope' })).toEqual([])
  })

  it('signs a picture only for its uploader or a reader of a post using it; a hidden post stops it', async () => {
    const shown = await upload(amy)
    const draft = await upload(amy)
    const { id } = post(amy, [{ kind: 'paragraph', text: '看這張' }, image(shown)])

    expect(await signed(ben, [shown, draft])).toEqual([shown])
    expect(await signed(amy, [shown, draft])).toEqual([draft, shown].sort())

    forum.setHidden(officer, id, { hidden: true })
    expect(await signed(ben, [shown])).toEqual([])
    // Its author and the officers still see the post, and so its picture
    expect(await signed(amy, [shown])).toEqual([shown])
    expect(await signed(officer, [shown])).toEqual([shown])

    forum.setHidden(officer, id, { hidden: false })
    expect(await signed(ben, [shown])).toEqual([shown])
  })

  it('signs a draft’s pictures for its author only, and a scheduled post’s for the officers too (e13-t12)', async () => {
    const drafted = await upload(amy)
    time += 60_000
    forum.createPost(amy, 'deals', { blocks: [image(drafted)], draft: true })
    const scheduled = await upload(officer)
    time += 60_000
    forum.createPost(officer, 'news', { blocks: [image(scheduled)], publishAt: time + 3_600_000 })
    const other = me('dan', ['forumModerate'])
    expect(await signed(amy, [drafted, scheduled])).toEqual([drafted])
    expect(await signed(ben, [drafted, scheduled])).toEqual([])
    expect(await signed(other, [drafted, scheduled])).toEqual([scheduled])
    // Still in use, so deleting another post never takes them
    expect(forum.imagesInUse([drafted, scheduled], 'all').size).toBe(2)
  })

  it('does not count a key quoted in text as a picture in use', async () => {
    const key = await upload(amy)
    post(amy, [{ kind: 'paragraph', text: `"${key}"` }])
    expect(forum.imagesInUse([key], 'all').size).toBe(0)
    expect(await signed(ben, [key])).toEqual([])
  })

  it('removes the pictures of a deleted post, unless another post uses them', async () => {
    const once = await upload(amy)
    const twice = await upload(amy)
    const first = post(amy, [image(once), image(twice)])
    post(amy, [image(twice)])
    const keys = postImageKeys(first.blocks)
    forum.deletePost(amy, first.id)
    expect(await releaseImages(files, forum, keys)).toEqual([once])
    expect(bucket.objects.has(once)).toBe(false)
    expect(bucket.objects.has(twice)).toBe(true)
  })

  it('removes a picture edited out of a post', async () => {
    const kept = await upload(amy)
    const dropped = await upload(amy)
    const before = post(amy, [image(kept), image(dropped)])
    const after = forum.updatePost(amy, before.id, { blocks: [image(kept)] })
    const gone = droppedImageKeys(before.blocks, after.blocks)
    expect(gone).toEqual([dropped])
    expect(await releaseImages(files, forum, gone)).toEqual([dropped])
    expect([...bucket.objects.keys()]).toEqual([kept])
  })

  it("on deleting an account, removes the member's pictures no post uses and keeps those in their posts", async () => {
    const posted = await upload(amy)
    const never = await upload(amy)
    const other = await upload(ben)
    post(amy, [image(posted)])
    expect(await files.forget(amy.id, (key) => forum.imagesInUse([key], 'all').size > 0)).toEqual([never])
    expect([...bucket.objects.keys()].sort()).toEqual([other, posted].sort())
  })

  it("on deleting an account, removes the member's drafts and scheduled posts and then their pictures (2026-11-03)", async () => {
    const posted = await upload(officer)
    const drafted = await upload(officer)
    const scheduled = await upload(officer)
    const published = post(officer, [image(posted)])
    time += 60_000
    const draft = forum.createPost(officer, 'deals', { blocks: [image(drafted)], draft: true })
    time += 60_000
    const later = forum.createPost(officer, 'news', { blocks: [image(scheduled)], publishAt: time + 3_600_000 })
    // Someone else's draft stays
    time += 60_000
    const amys = forum.createPost(amy, 'deals', { blocks: [{ kind: 'paragraph', text: '還沒寫完' }], draft: true })

    expect(forum.forgetUnpublished(officer.id).sort()).toEqual([draft.id, later.id].sort())
    expect(forum.scheduled()).toEqual([])
    expect(forum.unpublished(amy).posts.map((p) => p.id)).toEqual([amys.id])
    expect(forum.post(published.id).id).toBe(published.id)
    expect(await files.forget(officer.id, (key) => forum.imagesInUse([key], 'all').size > 0)).toEqual(expect.arrayContaining([drafted, scheduled]))
    expect([...bucket.objects.keys()]).toEqual([posted])
    // The scheduled post's job, when it wakes, finds nothing to publish
    expect(forum.publishScheduled(later.id, time + 3_600_000, () => true)).toBeNull()
  })
})

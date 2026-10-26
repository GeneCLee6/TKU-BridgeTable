import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AVATAR_MAX_BYTES, avatarUrl } from '../../shared/avatar.ts'
import { Avatar } from '../../src/components/Avatar.tsx'
import {
  AVATAR_MAX_ZOOM,
  clampCrop,
  encodeAvatar,
  initialCrop,
  moveCrop,
  sourceSquare,
  zoomCrop,
  type EncodeCanvas,
} from '../../src/lib/avatarImage.ts'
import { ToastProvider } from '../../src/components/Toast.tsx'
import { AccountPage } from '../../src/pages/AccountPage.tsx'
import { AuthProvider } from '../../src/state/AuthContext.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** Uploaded avatars (e1-t34): the picture when there is one, the initial otherwise or when it fails */

const show = (props: { id: string; name: string; avatar?: number }) =>
  render(
    <PreferencesProvider>
      <Avatar {...props} size={40} />
    </PreferencesProvider>,
  ).container.querySelector('[data-avatar]') as HTMLElement

describe('Avatar', () => {
  it('shows the uploaded picture at its versioned address', () => {
    const avatar = show({ id: 'amy', name: 'Amy Chen', avatar: 1234 })
    const img = avatar.querySelector('img')
    expect(img?.getAttribute('src')).toBe(avatarUrl('amy', 1234))
    expect(img?.getAttribute('alt')).toBe('')
    // The initial stays underneath while it loads
    expect(avatar.dataset.initials).toBe('AC')
    expect(avatar.getAttribute('aria-hidden')).toBe('true')
  })

  it('shows the initial without a picture', () => {
    const avatar = show({ id: 'amy', name: '陳怡君' })
    expect(avatar.querySelector('img')).toBeNull()
    expect(avatar.dataset.initials).toBe('陳')
  })

  it('falls back to the initial when the picture fails to load', () => {
    const avatar = show({ id: 'amy', name: 'amy', avatar: 7 })
    fireEvent.error(avatar.querySelector('img')!)
    expect(avatar.querySelector('img')).toBeNull()
    expect(avatar.dataset.initials).toBe('A')
  })
})

describe('cropping', () => {
  const wide = { width: 800, height: 400 }
  const frame = 256

  it('starts zoomed out with the picture centred over the frame', () => {
    const crop = initialCrop(wide, frame)
    expect(crop).toEqual({ zoom: 1, x: -128, y: 0 })
    expect(sourceSquare(crop, wide, frame)).toEqual({ sx: 200, sy: 0, size: 400 })
  })

  it('never lets an edge of the picture into the frame', () => {
    const crop = initialCrop(wide, frame)
    expect(moveCrop(crop, 500, 500, wide, frame)).toEqual({ zoom: 1, x: 0, y: 0 })
    expect(moveCrop(crop, -500, -500, wide, frame)).toEqual({ zoom: 1, x: -256, y: 0 })
    expect(clampCrop({ zoom: 0.2, x: 0, y: 0 }, wide, frame).zoom).toBe(1)
    expect(clampCrop({ zoom: 99, x: 0, y: 0 }, wide, frame).zoom).toBe(AVATAR_MAX_ZOOM)
  })

  it('zooms about the centre of the frame', () => {
    const square = { width: 512, height: 512 }
    const zoomed = zoomCrop(initialCrop(square, frame), 2, square, frame)
    expect(zoomed).toEqual({ zoom: 2, x: -128, y: -128 })
    expect(sourceSquare(zoomed, square, frame)).toEqual({ sx: 128, sy: 128, size: 256 })
  })
})

describe('encodeAvatar', () => {
  const encoder = (sizes: Record<string, number>, webp = true): EncodeCanvas & { asked: string[] } => {
    const asked: string[] = []
    const encode = async (type: string, quality: number) => {
      asked.push(`${type}@${quality}`)
      const written = type === 'image/webp' && !webp ? 'image/png' : type
      return new Blob([new Uint8Array(Math.round((sizes[written] ?? 1000) * quality))], { type: written })
    }
    return Object.assign(encode, { asked })
  }

  it('writes WebP at the best quality that fits', async () => {
    const encode = encoder({ 'image/webp': AVATAR_MAX_BYTES * 1.2 })
    const blob = await encodeAvatar(encode)
    expect(blob?.type).toBe('image/webp')
    expect(blob!.size).toBeLessThanOrEqual(AVATAR_MAX_BYTES)
    expect(encode.asked).toEqual(['image/webp@0.86', 'image/webp@0.76'])
  })

  it('writes JPEG where the browser cannot write WebP', async () => {
    const encode = encoder({}, false)
    expect((await encodeAvatar(encode))?.type).toBe('image/jpeg')
    expect(encode.asked).toEqual(['image/webp@0.86', 'image/jpeg@0.86'])
  })

  it('gives up when nothing fits', async () => {
    expect(await encodeAvatar(encoder({ 'image/webp': AVATAR_MAX_BYTES * 10, 'image/jpeg': AVATAR_MAX_BYTES * 10 }))).toBeNull()
  })
})

describe('my account: the avatar', () => {
  afterEach(() => vi.unstubAllGlobals())

  function account(avatar?: number) {
    let me: Record<string, unknown> = { id: 'amy', username: 'amy', admin: false, permissions: [], ...(avatar && { avatar }) }
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${url}`)
        if (url === '/api/account/avatar' && init?.method === 'DELETE') me = { ...me, avatar: undefined }
        return new Response(JSON.stringify({ user: me }), { status: 200 })
      }),
    )
    render(
      <PreferencesProvider>
        <ToastProvider>
          <AuthProvider>
            <MemoryRouter>
              <AccountPage />
            </MemoryRouter>
          </AuthProvider>
        </ToastProvider>
      </PreferencesProvider>,
    )
    return calls
  }

  it('offers an upload when there is no picture', async () => {
    account()
    expect(await screen.findByRole('button', { name: '上傳頭像' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '移除頭像' })).toBeNull()
  })

  it('turns down a file that is not a picture before reading it', async () => {
    account()
    await screen.findByRole('button', { name: '上傳頭像' })
    const input = screen.getByLabelText('上傳頭像', { selector: 'input' }) as HTMLInputElement
    await userEvent.upload(input, new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' }), { applyAccept: false })
    expect(await screen.findByText('頭像只能是 JPEG、PNG 或 WebP 圖片')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the picture and removes it', async () => {
    const calls = account(55)
    const remove = await screen.findByRole('button', { name: '移除頭像' })
    expect(document.querySelector(`img[src="${avatarUrl('amy', 55)}"]`)).not.toBeNull()
    await userEvent.click(remove)
    expect(await screen.findByText('頭像已移除')).toBeInTheDocument()
    expect(calls).toContain('DELETE /api/account/avatar')
    expect(await screen.findByRole('button', { name: '上傳頭像' })).toBeInTheDocument()
    expect(document.querySelector('img[src^="/api/avatar/"]')).toBeNull()
  })
})

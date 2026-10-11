import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  initializeFeedFile,
  openFeedStore,
} from '../../src/application/feed-store.js'
import { startFeedServer } from '../../src/cli/feed-server.js'

describe('local feed image API', () => {
  it('reports saved image counts and exposes persisted image references in the archive', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xlog-image-api-'))
    const file = join(dir, 'state.db')
    const imageRoot = join(dir, 'media')
    await initializeFeedFile(file)
    const bytes = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ])
    const fetchImage = vi.fn<typeof fetch>().mockImplementation((input) => {
      const imageResponse = new Response(bytes, {
        headers: { 'content-type': 'image/png' },
      })
      Object.defineProperties(imageResponse, {
        redirected: { value: false },
        url: { value: String(input) },
      })
      return Promise.resolve(imageResponse)
    })
    const store = await openFeedStore(file, { imageRoot, fetchImage })
    await store.setHandles(['example_user'])
    const server = await startFeedServer(store, 0)
    const address = server.address()
    if (address === null || typeof address === 'string')
      throw new Error('expected TCP address')
    const base = `http://127.0.0.1:${address.port}`

    try {
      const capture = await fetch(`${base}/api/captures`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-xlog-client': 'extension',
        },
        body: JSON.stringify({
          posts: [
            {
              id: '700',
              author: 'example_user',
              text: 'post with an image',
              url: 'https://x.com/example_user/status/700',
              postedAt: null,
              threadRootId: null,
              images: [
                {
                  url: 'https://pbs.twimg.com/media/ApiMedia?format=png&name=large',
                  mediaId: 'ApiMedia',
                  position: 1,
                },
              ],
            },
          ],
          observedAt: '2026-10-11T12:00:00.000Z',
        }),
      })
      expect(capture.status).toBe(200)
      expect(await capture.json()).toEqual({
        added: 1,
        updated: 0,
        imagesSaved: 1,
        imagesFailed: 0,
      })

      const archiveResponse = await fetch(`${base}/api/archive`)
      expect(archiveResponse.status).toBe(200)
      const archive = (await archiveResponse.json()) as {
        posts: Record<
          string,
          {
            images: Array<{
              mediaId: string
              position: number
              sourceUrl: string
              localPath: string | null
              mimeType: string | null
              byteLength: number | null
              sha256: string | null
              status: string
              error: string | null
            }>
          }
        >
      }
      expect(archive.posts['700']?.images).toEqual([
        expect.objectContaining({
          mediaId: 'ApiMedia',
          position: 1,
          sourceUrl:
            'https://pbs.twimg.com/media/ApiMedia?format=png&name=large',
          mimeType: 'image/png',
          byteLength: bytes.byteLength,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          status: 'saved',
          error: null,
          localPath: expect.any(String),
        }),
      ])
      const localPath = archive.posts['700']?.images[0]?.localPath
      if (localPath === null || localPath === undefined)
        throw new Error('expected archive to reference a local image')
      const fullPath = isAbsolute(localPath)
        ? localPath
        : resolve(imageRoot, localPath)
      await expect(readFile(fullPath)).resolves.toEqual(Buffer.from(bytes))
    } finally {
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      )
      store.close()
    }
  })
})

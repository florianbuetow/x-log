import { mkdtemp } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  initializeFeedFile,
  openFeedStore,
  type FeedStore,
} from '../../src/application/feed-store.js'
import { startFeedServer } from '../../src/cli/feed-server.js'

describe('local feed API', () => {
  it('serves config, accepts captures, and rejects web origins', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xlog-api-'))
    const file = join(dir, 'state.json')
    await initializeFeedFile(file)
    const store = await openFeedStore(file)
    const server = await startFeedServer(store, 0)
    const address = server.address()
    if (address === null || typeof address === 'string')
      throw new Error('expected TCP address')
    const base = `http://127.0.0.1:${address.port}`
    try {
      const config = await fetch(`${base}/api/config`)
      expect(config.status).toBe(200)
      expect(config.headers.get('content-type')).toBe(
        'application/json; charset=utf-8',
      )
      expect(config.headers.get('cache-control')).toBe('no-store')
      expect(await config.json()).toEqual({ followedHandles: [] })
      const extensionRead = await fetch(`${base}/api/config?fresh=1`, {
        headers: {
          Origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      })
      expect(extensionRead.status).toBe(200)
      const denied = await fetch(`${base}/api/config`, {
        headers: { Origin: 'https://evil.example' },
      })
      expect(denied.status).toBe(403)
      const invalidHostStatus = await new Promise<number>((resolve, reject) => {
        const request = httpRequest(
          {
            hostname: '127.0.0.1',
            port: address.port,
            path: '/api/config',
            headers: { Host: 'evil.example' },
          },
          (response) => {
            response.resume()
            response.on('end', () => resolve(response.statusCode ?? 0))
          },
        )
        request.on('error', reject)
        request.end()
      })
      expect(invalidHostStatus).toBe(403)
      const updated = await fetch(`${base}/api/config`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-xlog-client': 'extension',
        },
        body: JSON.stringify({ followedHandles: ['example_user', '@another'] }),
      })
      expect(await updated.json()).toEqual({
        followedHandles: ['example_user', 'another'],
      })
      const configAfterUpdate = await fetch(`${base}/api/config`)
      expect(await configAfterUpdate.json()).toEqual({
        followedHandles: ['example_user', 'another'],
      })
      const invalidConfig = await fetch(`${base}/api/config`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-xlog-client': 'extension',
        },
        body: JSON.stringify({ followedHandles: ['invalid!'] }),
      })
      expect(invalidConfig.status).toBe(400)
      const configWithoutHeader = await fetch(`${base}/api/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ followedHandles: [] }),
      })
      expect(configWithoutHeader.status).toBe(403)
      const capture = await fetch(`${base}/api/captures`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-xlog-client': 'extension',
        },
        body: JSON.stringify({
          posts: [
            {
              id: '123',
              author: 'example_user',
              text: 'hello',
              url: 'https://x.com/example_user/status/123',
              postedAt: null,
              threadRootId: null,
            },
          ],
          observedAt: '2026-10-11T12:00:00Z',
        }),
      })
      expect(await capture.json()).toEqual({
        added: 1,
        updated: 0,
        imagesSaved: 0,
        imagesFailed: 0,
      })
      const duplicate = await fetch(`${base}/api/captures`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-xlog-client': 'extension',
        },
        body: JSON.stringify({
          posts: [
            {
              id: '123',
              author: 'example_user',
              text: 'hello',
              url: 'https://x.com/example_user/status/123',
              postedAt: null,
              threadRootId: null,
            },
          ],
          observedAt: '2026-10-11T12:00:00Z',
        }),
      })
      expect(await duplicate.json()).toEqual({
        added: 0,
        updated: 0,
        imagesSaved: 0,
        imagesFailed: 0,
      })
      const archive = await fetch(`${base}/api/archive`)
      expect(await archive.json()).toHaveProperty('posts.123.text', 'hello')
      const status = await fetch(`${base}/api/status`)
      expect(await status.json()).toEqual({
        followedHandles: ['example_user', 'another'],
        postCount: 1,
        threadCount: 0,
      })
      const reply = await fetch(`${base}/api/captures`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-xlog-client': 'extension',
        },
        body: JSON.stringify({
          posts: [
            {
              id: '124',
              author: 'someone',
              text: 'reply',
              url: 'https://x.com/someone/status/124',
              postedAt: null,
              threadRootId: '123',
            },
          ],
          observedAt: '2026-10-11T12:01:00Z',
        }),
      })
      expect(await reply.json()).toEqual({
        added: 1,
        updated: 0,
        imagesSaved: 0,
        imagesFailed: 0,
      })
      const events = await fetch(`${base}/api/events?limit=100`)
      expect(await events.json()).toEqual({
        totalPosts: 2,
        events: [
          expect.objectContaining({
            kind: 'thread',
            postId: '123',
            replyCount: 1,
            title: 'hello',
          }),
          expect.objectContaining({
            kind: 'post',
            postId: '123',
            replyCount: 0,
            title: 'hello',
          }),
        ],
      })
      const latest = await fetch(`${base}/api/events?limit=1`)
      expect(await latest.json()).toEqual({
        totalPosts: 2,
        events: [expect.objectContaining({ kind: 'thread', replyCount: 1 })],
      })
      expect((await fetch(`${base}/api/events?limit=0`)).status).toBe(400)
      expect((await fetch(`${base}/api/events?limit=abc`)).status).toBe(400)
      expect((await fetch(`${base}/api/events?limit=101`)).status).toBe(400)

      const missingHeader = await fetch(`${base}/api/captures`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      expect(missingHeader.status).toBe(403)
      const invalidJson = await fetch(`${base}/api/captures`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-xlog-client': 'extension',
        },
        body: '{bad',
      })
      expect(invalidJson.status).toBe(400)
      const wrongType = await fetch(`${base}/api/captures`, {
        method: 'POST',
        headers: {
          'content-type': 'text/plain',
          'x-xlog-client': 'extension',
        },
        body: '{}',
      })
      expect(wrongType.status).toBe(415)
      const oversized = await fetch(`${base}/api/captures`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-xlog-client': 'extension',
        },
        body: JSON.stringify({ padding: 'x'.repeat(1_000_001) }),
      })
      expect(oversized.status).toBe(413)
      const invalidCapture = await fetch(`${base}/api/captures`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-xlog-client': 'extension',
        },
        body: JSON.stringify({
          posts: 'invalid',
          observedAt: '2026-10-11T12:00:00Z',
        }),
      })
      expect(invalidCapture.status).toBe(400)
      expect((await fetch(`${base}/missing`)).status).toBe(404)
      await expect(startFeedServer(store, address.port)).rejects.toThrow(
        'cannot listen',
      )
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })

  it('returns a safe error when storage fails', async () => {
    const broken: FeedStore = {
      getState: () => {
        throw new Error('private disk detail')
      },
      getArchive: () => {
        throw new Error('private disk detail')
      },
      setHandles: async () => {
        throw new Error('private disk detail')
      },
      ingest: async () => {
        throw new Error('private disk detail')
      },
      getEvents: () => [],
      close: () => undefined,
    }
    const server = await startFeedServer(broken, 0)
    const address = server.address()
    if (address === null || typeof address === 'string')
      throw new Error('expected TCP address')
    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/config`,
      )
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({
        error: 'feed service failed to process request',
      })
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })
})

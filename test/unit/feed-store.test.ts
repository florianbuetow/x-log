import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { describe, expect, it } from 'vitest'

import {
  initializeFeedFile,
  migrateFeedFile,
  openFeedStore,
} from '../../src/application/feed-store.js'

const observedAt = '2026-10-11T12:00:00.000Z'

describe('feed store', () => {
  it('initializes a SQLite database, persists config and captures, and rejects overwrite', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xlog-feed-'))
    const file = join(dir, 'state.db')
    await initializeFeedFile(file)
    await expect(initializeFeedFile(file)).rejects.toThrow('cannot initialize')

    expect((await readFile(file)).subarray(0, 16).toString()).toBe(
      'SQLite format 3\0',
    )

    const store = await openFeedStore(file)
    expect(store.getState().followedHandles).toEqual([])
    await store.setHandles(['@example_user', '@another'])
    await store.ingest({
      posts: [
        {
          id: '123',
          author: 'another',
          text: 'hello',
          url: 'https://x.com/another/status/123',
          postedAt: null,
          threadRootId: null,
        },
      ],
      observedAt,
    })

    const reopened = await openFeedStore(file)
    expect(reopened.getState().followedHandles).toEqual([
      'example_user',
      'another',
    ])
    expect(reopened.getState().posts['123']).toMatchObject({
      id: '123',
      author: 'another',
      text: 'hello',
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
    })
  })

  it('fails on a missing database rather than silently creating it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xlog-feed-'))
    const file = join(dir, 'missing.db')

    await expect(openFeedStore(file)).rejects.toThrow(
      `cannot open feed state at ${file}`,
    )
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a non-SQLite file with a contextual store error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xlog-feed-'))
    const file = join(dir, 'state.db')
    await writeFile(file, 'this is not a SQLite database')

    await expect(openFeedStore(file)).rejects.toMatchObject({
      name: 'FeedStoreError',
      message: expect.stringContaining(`cannot open feed state at ${file}`),
      cause: expect.any(Error),
    })
  })

  it('serializes concurrent config and capture writes in call order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xlog-feed-'))
    const file = join(dir, 'state.db')
    await initializeFeedFile(file)
    const store = await openFeedStore(file)

    const handles = store.setHandles(['new_author'])
    const capture = store.ingest({
      posts: [
        {
          id: '123',
          author: 'new_author',
          text: 'captured after config update',
          url: 'https://x.com/new_author/status/123',
          postedAt: null,
          threadRootId: null,
        },
      ],
      observedAt,
    })

    await expect(handles).resolves.toEqual(['new_author'])
    await expect(capture).resolves.toMatchObject({ added: 1, updated: 0 })

    const reopened = await openFeedStore(file)
    expect(reopened.getState().followedHandles).toEqual(['new_author'])
    expect(reopened.getState().posts['123']?.text).toBe(
      'captured after config update',
    )
  })

  it('deduplicates posts and thread links by numeric X status ID', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xlog-feed-'))
    const file = join(dir, 'state.db')
    await initializeFeedFile(file)
    const store = await openFeedStore(file)
    await store.setHandles(['example_user'])

    await store.ingest({
      posts: [
        {
          id: '100',
          author: 'example_user',
          text: 'root',
          url: 'https://x.com/example_user/status/100',
          postedAt: null,
          threadRootId: null,
        },
        {
          id: '100',
          author: 'example_user',
          text: 'root',
          url: 'https://x.com/example_user/status/100',
          postedAt: null,
          threadRootId: null,
        },
        {
          id: '101',
          author: 'somebody',
          text: 'first version',
          url: 'https://x.com/somebody/status/101',
          postedAt: null,
          threadRootId: '100',
        },
      ],
      observedAt,
    })
    const result = await store.ingest({
      posts: [
        {
          id: '101',
          author: 'somebody',
          text: 'updated version',
          url: 'https://x.com/somebody/status/101',
          postedAt: null,
          threadRootId: '100',
        },
      ],
      observedAt: '2026-10-11T13:00:00.000Z',
    })

    expect(result).toMatchObject({ added: 0, updated: 1 })
    expect(
      store.getEvents(10).filter((event) => event.kind === 'post'),
    ).toEqual([expect.objectContaining({ postId: '100' })])
    const reopened = await openFeedStore(file)
    expect(Object.keys(reopened.getState().posts)).toEqual(['100', '101'])
    expect(reopened.getState().posts['101']).toMatchObject({
      text: 'updated version',
      firstSeenAt: observedAt,
      lastSeenAt: '2026-10-11T13:00:00.000Z',
    })
    expect(reopened.getState().threads['100']).toEqual(['101'])
  })

  it('returns newest capture events first with limits, normalized titles, and fallback titles', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xlog-feed-'))
    const file = join(dir, 'state.db')
    await initializeFeedFile(file)
    const store = await openFeedStore(file)
    await store.setHandles(['example_user'])
    const longText = `  ${'word '.repeat(40)}  `
    const expectedTitle = longText.replace(/\s+/g, ' ').trim().slice(0, 160)

    await store.ingest({
      posts: [
        {
          id: '200',
          author: 'example_user',
          text: ' \n\t ',
          url: 'https://x.com/example_user/status/200',
          postedAt: null,
          threadRootId: null,
        },
      ],
      observedAt: '2026-10-11T12:00:00.000Z',
    })
    await store.ingest({
      posts: [
        {
          id: '201',
          author: 'example_user',
          text: longText,
          url: 'https://x.com/example_user/status/201',
          postedAt: null,
          threadRootId: null,
        },
      ],
      observedAt: '2026-10-11T12:01:00.000Z',
    })
    await store.ingest({
      posts: [
        {
          id: '202',
          author: 'another',
          text: 'a reply',
          url: 'https://x.com/another/status/202',
          postedAt: null,
          threadRootId: '201',
        },
      ],
      observedAt: '2026-10-11T12:02:00.000Z',
    })

    expect(store.getEvents(0)).toEqual([])
    expect(store.getEvents(1)).toEqual([
      {
        id: 3,
        kind: 'thread',
        postId: '201',
        author: 'example_user',
        title: expectedTitle,
        replyCount: 1,
        capturedAt: '2026-10-11T12:02:00.000Z',
      },
    ])
    expect(store.getEvents(3)).toEqual([
      expect.objectContaining({ id: 3, kind: 'thread' }),
      expect.objectContaining({
        id: 2,
        kind: 'post',
        postId: '201',
        title: expectedTitle,
      }),
      expect.objectContaining({
        id: 1,
        kind: 'post',
        postId: '200',
        title: 'Post by @example_user',
      }),
    ])
  })

  it('keeps state unchanged after rejected input and continues queued work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xlog-feed-'))
    const file = join(dir, 'state.db')
    await initializeFeedFile(file)
    const store = await openFeedStore(file)

    const rejected = store.setHandles(['invalid-handle'])
    const accepted = store.setHandles(['@Valid_Handle'])

    await expect(rejected).rejects.toThrow('invalid followed handle')
    await expect(accepted).resolves.toEqual(['valid_handle'])
    expect(store.getState().followedHandles).toEqual(['valid_handle'])
    expect((await openFeedStore(file)).getState().followedHandles).toEqual([
      'valid_handle',
    ])
  })

  it('does not mutate persisted state when capture validation fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xlog-feed-'))
    const file = join(dir, 'state.db')
    await initializeFeedFile(file)
    const store = await openFeedStore(file)
    const before = store.getState()

    await expect(
      store.ingest({ posts: [], observedAt: 'not-a-date' }),
    ).rejects.toThrow('observedAt must be an ISO date-time')

    expect(store.getState()).toBe(before)
    expect((await openFeedStore(file)).getState()).toEqual(before)
  })

  it('rolls back the whole config transaction when a later insert fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xlog-feed-'))
    const file = join(dir, 'state.db')
    await initializeFeedFile(file)
    const database = new DatabaseSync(file)
    database.exec(`
      CREATE TRIGGER reject_test_handle
      BEFORE INSERT ON followed_handles
      WHEN NEW.handle = 'explode'
      BEGIN
        SELECT RAISE(ABORT, 'forced handle failure');
      END
    `)
    database.close()
    const store = await openFeedStore(file)

    await expect(store.setHandles(['first', 'explode'])).rejects.toThrow(
      'forced handle failure',
    )

    expect(store.getState().followedHandles).toEqual([])
    store.close()
    const reopened = await openFeedStore(file)
    expect(reopened.getState().followedHandles).toEqual([])
    reopened.close()
  })

  it('migrates a JSON archive without changing the source or losing archive fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xlog-feed-'))
    const source = join(dir, 'archive.json')
    const target = join(dir, 'archive.db')
    const sourceContents = `${JSON.stringify(
      {
        version: 1,
        followedHandles: ['example_user', 'another'],
        posts: {
          '100': {
            id: '100',
            author: 'example_user',
            text: 'root text',
            url: 'https://x.com/example_user/status/100',
            postedAt: '2026-10-10T09:30:00.000Z',
            threadRootId: null,
            firstSeenAt: '2026-10-10T10:00:00.000Z',
            lastSeenAt: '2026-10-11T10:00:00.000Z',
          },
          '101': {
            id: '101',
            author: 'another',
            text: 'reply text',
            url: 'https://x.com/another/status/101',
            postedAt: null,
            threadRootId: '100',
            firstSeenAt: '2026-10-10T10:01:00.000Z',
            lastSeenAt: '2026-10-10T10:02:00.000Z',
          },
        },
        threads: { '100': ['101'] },
      },
      null,
      2,
    )}\n`
    await writeFile(source, sourceContents)

    await migrateFeedFile(source, target)

    expect(await readFile(source, 'utf8')).toBe(sourceContents)
    const store = await openFeedStore(target)
    const state = store.getState()
    expect(state.followedHandles).toEqual(['example_user', 'another'])
    expect(state.posts['100']).toEqual({
      id: '100',
      author: 'example_user',
      text: 'root text',
      url: 'https://x.com/example_user/status/100',
      postedAt: '2026-10-10T09:30:00.000Z',
      threadRootId: null,
      firstSeenAt: '2026-10-10T10:00:00.000Z',
      lastSeenAt: '2026-10-11T10:00:00.000Z',
    })
    expect(state.posts['101']).toEqual({
      id: '101',
      author: 'another',
      text: 'reply text',
      url: 'https://x.com/another/status/101',
      postedAt: null,
      threadRootId: '100',
      firstSeenAt: '2026-10-10T10:01:00.000Z',
      lastSeenAt: '2026-10-10T10:02:00.000Z',
    })
    expect(state.threads['100']).toEqual(['101'])
    expect(store.getEvents(10)).toEqual([
      {
        id: 2,
        kind: 'thread',
        postId: '100',
        author: 'example_user',
        title: 'root text',
        replyCount: 1,
        capturedAt: '2026-10-10T10:01:00.000Z',
      },
      {
        id: 1,
        kind: 'post',
        postId: '100',
        author: 'example_user',
        title: 'root text',
        replyCount: 0,
        capturedAt: '2026-10-10T10:00:00.000Z',
      },
    ])
  })

  it('removes a partial migration database when its transaction fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xlog-feed-'))
    const source = join(dir, 'duplicate-thread.json')
    const target = join(dir, 'partial.db')
    await writeFile(
      source,
      JSON.stringify({
        version: 1,
        followedHandles: ['example_user'],
        posts: {
          '300': {
            id: '300',
            author: 'example_user',
            text: 'root',
            url: 'https://x.com/example_user/status/300',
            postedAt: null,
            threadRootId: null,
            firstSeenAt: observedAt,
            lastSeenAt: observedAt,
          },
          '301': {
            id: '301',
            author: 'another',
            text: 'reply',
            url: 'https://x.com/another/status/301',
            postedAt: null,
            threadRootId: '300',
            firstSeenAt: observedAt,
            lastSeenAt: observedAt,
          },
        },
        threads: { '300': ['301', '301'] },
      }),
    )

    await expect(migrateFeedFile(source, target)).rejects.toThrow(
      'UNIQUE constraint failed',
    )
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a migration whose reply references a missing root post', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xlog-feed-'))
    const source = join(dir, 'broken-foreign-key.json')
    const target = join(dir, 'broken-foreign-key.db')
    await writeFile(
      source,
      JSON.stringify({
        version: 1,
        followedHandles: ['example_user'],
        posts: {
          '401': {
            id: '401',
            author: 'another',
            text: 'orphan reply',
            url: 'https://x.com/another/status/401',
            postedAt: null,
            threadRootId: '400',
            firstSeenAt: observedAt,
            lastSeenAt: observedAt,
          },
        },
        threads: { '400': ['401'] },
      }),
    )

    await expect(migrateFeedFile(source, target)).rejects.toThrow(
      'FOREIGN KEY constraint failed',
    )
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects databases with missing or unsupported schema metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xlog-feed-'))
    const missingTable = join(dir, 'missing-table.db')
    const missingVersion = join(dir, 'missing-version.db')
    await initializeFeedFile(missingTable)
    await initializeFeedFile(missingVersion)

    const first = new DatabaseSync(missingTable)
    first.exec('DROP TABLE posts')
    first.close()
    const second = new DatabaseSync(missingVersion)
    second.exec('DELETE FROM schema_info')
    second.close()

    await expect(openFeedStore(missingTable)).rejects.toThrow('no such table')
    await expect(openFeedStore(missingVersion)).rejects.toThrow(
      'unsupported feed state version',
    )
  })

  it('does not overwrite an existing migration target', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xlog-feed-'))
    const source = join(dir, 'archive.json')
    const target = join(dir, 'existing.db')
    await writeFile(
      source,
      JSON.stringify({
        version: 1,
        followedHandles: ['another'],
        posts: {},
        threads: {},
      }),
    )
    await initializeFeedFile(target)

    await expect(migrateFeedFile(source, target)).rejects.toThrow(
      'cannot initialize feed state',
    )

    expect((await openFeedStore(target)).getState()).toEqual({
      version: 1,
      followedHandles: [],
      posts: {},
      threads: {},
    })
  })
})

import { describe, expect, it } from 'vitest'

import {
  FeedValidationError,
  ingestCaptures,
  normalizeHandles,
  parseCaptureBatch,
  parseConfig,
  type FeedState,
} from '../../src/domain/feed.js'

const observedAt = '2026-10-11T12:00:00.000Z'

const initial: FeedState = {
  version: 1,
  followedHandles: ['example_user'],
  posts: {},
  threads: {},
}

function post(id: string, author: string, threadRootId: string | null = null) {
  return {
    id,
    author,
    text: `post ${id}`,
    url: `https://x.com/${author}/status/${id}`,
    postedAt: null,
    threadRootId,
  }
}

describe('feed input validation', () => {
  it('normalizes, trims, and deduplicates followed handles in input order', () => {
    expect(
      normalizeHandles(['@Example_User', 'example_user', ' Other_1 ']),
    ).toEqual(['example_user', 'other_1'])
  })

  it.each([
    [null, 'followedHandles must be an array'],
    [{}, 'followedHandles must be an array'],
    [[123], 'each followed handle must be a string'],
    [['@'], 'invalid followed handle'],
    [['has-hyphen'], 'invalid followed handle'],
    [['abcdefghijklmnop'], 'invalid followed handle'],
  ])('rejects invalid followed handle input %#', (value, message) => {
    expect(() => normalizeHandles(value)).toThrow(message)
  })

  it('parses handles from a config object and rejects non-object configs', () => {
    expect(parseConfig({ followedHandles: ['@Example_User'] })).toEqual([
      'example_user',
    ])
    for (const value of [null, [], 'config']) {
      expect(() => parseConfig(value)).toThrow('expected a JSON object')
    }
  })

  it('canonicalizes accepted post URLs, author casing, and ISO dates', () => {
    const result = parseCaptureBatch({
      posts: [
        {
          ...post('123', 'Example_User'),
          url: 'https://twitter.com/Example_User/status/123',
          postedAt: '2026-10-11T14:00:00+02:00',
        },
      ],
      observedAt: '2026-10-11T14:30:00+02:00',
    })

    expect(result).toEqual({
      posts: [
        {
          ...post('123', 'example_user'),
          postedAt: observedAt,
        },
      ],
      observedAt: '2026-10-11T12:30:00.000Z',
    })
  })

  it('accepts documented post and batch size boundaries', () => {
    const result = parseCaptureBatch({
      posts: Array.from({ length: 100 }, (_, index) => ({
        ...post(String(index + 1), 'abcdefghijklmno'),
        text: 'x'.repeat(50_000),
      })),
      observedAt,
    })

    expect(result.posts).toHaveLength(100)
    expect(result.posts[0]?.text).toHaveLength(50_000)
  })

  it.each([
    [{ posts: {}, observedAt }, 'posts must be an array'],
    [
      {
        posts: Array.from({ length: 101 }, (_, index) =>
          post(String(index + 1), 'example_user'),
        ),
        observedAt,
      },
      'posts must be an array',
    ],
    [{ posts: [null], observedAt }, 'expected a JSON object'],
    [{ posts: [post('', 'example_user')], observedAt }, 'post id'],
    [
      {
        posts: [post('12345678901234567890123456', 'example_user')],
        observedAt,
      },
      'post id',
    ],
    [{ posts: [post('1', 'has-hyphen')], observedAt }, 'post author'],
    [
      { posts: [{ ...post('1', 'example_user'), text: 1 }], observedAt },
      'post text',
    ],
    [
      {
        posts: [{ ...post('1', 'example_user'), text: 'x'.repeat(50_001) }],
        observedAt,
      },
      'post text',
    ],
    [
      {
        posts: [
          {
            ...post('123', 'example_user'),
            url: 'https://x.com/other/status/123',
          },
        ],
        observedAt,
      },
      'post URL',
    ],
    [
      {
        posts: [{ ...post('1', 'example_user'), postedAt: undefined }],
        observedAt,
      },
      'postedAt is required',
    ],
    [
      {
        posts: [
          { ...post('1', 'example_user'), postedAt: '2026-99-99T00:00:00Z' },
        ],
        observedAt,
      },
      'postedAt must be an ISO date-time',
    ],
    [
      {
        posts: [{ ...post('1', 'example_user'), threadRootId: undefined }],
        observedAt,
      },
      'threadRootId',
    ],
    [{ posts: [], observedAt: 'bad' }, 'observedAt'],
  ])('rejects malformed capture input %#', (value, message) => {
    expect(() => parseCaptureBatch(value)).toThrow(message)
  })

  it('uses the typed validation error for invalid input', () => {
    expect(() => normalizeHandles('example_user')).toThrow(FeedValidationError)
  })
})

describe('feed ingestion', () => {
  it('stores followed roots with first-seen and last-seen timestamps', () => {
    const result = ingestCaptures(initial, {
      posts: [post('1', 'example_user')],
      observedAt,
    })

    expect(result.added).toBe(1)
    expect(result.updated).toBe(0)
    expect(result.state.posts['1']).toEqual({
      ...post('1', 'example_user'),
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
    })
  })

  it('ignores unfollowed roots, orphan replies, and replies to replies', () => {
    const state: FeedState = {
      ...initial,
      posts: {
        '10': {
          ...post('10', 'example_user', '1'),
          firstSeenAt: observedAt,
          lastSeenAt: observedAt,
        },
      },
    }
    const result = ingestCaptures(state, {
      posts: [
        post('1', 'stranger'),
        post('2', 'other', '1'),
        post('11', 'other', '10'),
      ],
      observedAt,
    })

    expect(result).toMatchObject({ added: 0, updated: 0 })
    expect(result.state.posts).toEqual(state.posts)
    expect(result.state.threads).toEqual({})
  })

  it('stores exactly the first 20 unique replies to a followed root', () => {
    const replies = Array.from({ length: 21 }, (_, index) =>
      post(String(index + 2), 'someone', '1'),
    )
    const result = ingestCaptures(initial, {
      posts: [post('1', 'example_user'), ...replies, replies[0]!],
      observedAt,
    })

    expect(result.added).toBe(21)
    expect(result.updated).toBe(0)
    expect(result.state.threads['1']).toEqual(
      Array.from({ length: 20 }, (_, index) => String(index + 2)),
    )
    expect(result.state.posts['22']).toBeUndefined()
  })

  it('allows an existing reply to be updated after the thread reaches its cap', () => {
    const first = ingestCaptures(initial, {
      posts: [
        post('1', 'example_user'),
        ...Array.from({ length: 20 }, (_, index) =>
          post(String(index + 2), 'someone', '1'),
        ),
      ],
      observedAt,
    })
    const updatedAt = '2026-10-12T12:00:00.000Z'
    const second = ingestCaptures(first.state, {
      posts: [{ ...post('2', 'someone', '1'), text: 'edited reply' }],
      observedAt: updatedAt,
    })

    expect(second).toMatchObject({ added: 0, updated: 1 })
    expect(second.state.posts['2']).toMatchObject({
      text: 'edited reply',
      firstSeenAt: observedAt,
      lastSeenAt: updatedAt,
    })
    expect(second.state.threads['1']).toHaveLength(20)
  })

  it('does not update a post observed twice unchanged at the same time', () => {
    const first = ingestCaptures(initial, {
      posts: [post('1', 'example_user')],
      observedAt,
    })
    const second = ingestCaptures(first.state, {
      posts: [post('1', 'example_user')],
      observedAt,
    })

    expect(second).toMatchObject({ added: 0, updated: 0 })
    expect(second.state.posts['1']).toEqual(first.state.posts['1'])
  })

  it.each([
    ['changed text', { text: 'edited' }],
    ['changed publication time', { postedAt: '2026-10-10T12:00:00.000Z' }],
    ['a later observation', {}],
  ])('updates last-seen time for %s', (_label, changes) => {
    const first = ingestCaptures(initial, {
      posts: [post('1', 'example_user')],
      observedAt,
    })
    const updatedAt = '2026-10-12T12:00:00.000Z'
    const second = ingestCaptures(first.state, {
      posts: [{ ...post('1', 'example_user'), ...changes }],
      observedAt: updatedAt,
    })

    expect(second).toMatchObject({ added: 0, updated: 1 })
    expect(second.state.posts['1']?.firstSeenAt).toBe(observedAt)
    expect(second.state.posts['1']?.lastSeenAt).toBe(updatedAt)
  })
})

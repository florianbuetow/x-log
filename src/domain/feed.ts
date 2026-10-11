interface CapturedPost {
  readonly id: string
  readonly author: string
  readonly text: string
  readonly url: string
  readonly postedAt: string | null
  readonly threadRootId: string | null
}

interface StoredPost extends CapturedPost {
  readonly firstSeenAt: string
  readonly lastSeenAt: string
}

export interface FeedState {
  readonly version: 1
  readonly followedHandles: readonly string[]
  readonly posts: Readonly<Record<string, StoredPost>>
  readonly threads: Readonly<Record<string, readonly string[]>>
}

export interface CaptureBatch {
  readonly posts: readonly CapturedPost[]
  readonly observedAt: string
}

export interface IngestResult {
  readonly state: FeedState
  readonly added: number
  readonly updated: number
}

export class FeedValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FeedValidationError'
  }
}

const HANDLE = /^[a-zA-Z0-9_]{1,15}$/
const POST_ID = /^\d{1,25}$/

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FeedValidationError('expected a JSON object')
  }
  return value as Record<string, unknown>
}

function isoDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value)) {
    throw new FeedValidationError(`${field} must be an ISO date-time`)
  }
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) {
    throw new FeedValidationError(`${field} must be an ISO date-time`)
  }
  return date.toISOString()
}

export function normalizeHandles(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new FeedValidationError('followedHandles must be an array')
  }
  const handles = value.map((item: unknown) => {
    if (typeof item !== 'string') {
      throw new FeedValidationError('each followed handle must be a string')
    }
    const handle = item.trim().replace(/^@/, '').toLowerCase()
    if (!HANDLE.test(handle)) {
      throw new FeedValidationError(`invalid followed handle: ${item}`)
    }
    return handle
  })
  return [...new Set(handles)]
}

export function parseConfig(value: unknown): readonly string[] {
  const input = record(value)
  return normalizeHandles(input['followedHandles'])
}

function parsePost(value: unknown): CapturedPost {
  const input = record(value)
  const id = input['id']
  const author = input['author']
  const text = input['text']
  const url = input['url']
  const postedAt = input['postedAt']
  const threadRootId = input['threadRootId']
  if (typeof id !== 'string' || !POST_ID.test(id)) {
    throw new FeedValidationError('post id must be numeric')
  }
  if (typeof author !== 'string' || !HANDLE.test(author)) {
    throw new FeedValidationError('post author must be an X handle')
  }
  if (typeof text !== 'string' || text.length > 50_000) {
    throw new FeedValidationError(
      'post text must be a string of at most 50000 characters',
    )
  }
  const canonicalUrl = `https://x.com/${author}/status/${id}`
  if (
    url !== canonicalUrl &&
    url !== `https://twitter.com/${author}/status/${id}`
  ) {
    throw new FeedValidationError('post URL must match its author and id')
  }
  if (postedAt === undefined) {
    throw new FeedValidationError('postedAt is required')
  }
  if (postedAt !== null) {
    isoDate(postedAt, 'postedAt')
  }
  if (
    threadRootId !== null &&
    (typeof threadRootId !== 'string' || !POST_ID.test(threadRootId))
  ) {
    throw new FeedValidationError('threadRootId must be a numeric id or null')
  }
  return {
    id,
    author: author.toLowerCase(),
    text,
    url: `https://x.com/${author.toLowerCase()}/status/${id}`,
    postedAt: postedAt === null ? null : isoDate(postedAt, 'postedAt'),
    threadRootId: threadRootId as string | null,
  }
}

export function parseCaptureBatch(value: unknown): CaptureBatch {
  const input = record(value)
  const posts = input['posts']
  if (!Array.isArray(posts) || posts.length > 100) {
    throw new FeedValidationError('posts must be an array of at most 100 posts')
  }
  return {
    posts: posts.map(parsePost),
    observedAt: isoDate(input['observedAt'], 'observedAt'),
  }
}

export function ingestCaptures(
  state: FeedState,
  batch: CaptureBatch,
): IngestResult {
  const posts: Record<string, StoredPost> = { ...state.posts }
  const threads: Record<string, readonly string[]> = { ...state.threads }
  let added = 0
  let updated = 0
  const followed = new Set(state.followedHandles)

  for (const post of batch.posts) {
    const rootId = post.threadRootId
    if (rootId === null) {
      if (!followed.has(post.author)) continue
    } else {
      const root = posts[rootId]
      if (
        root === undefined ||
        !followed.has(root.author) ||
        root.threadRootId !== null
      )
        continue
      const replies = threads[rootId] ?? []
      if (!replies.includes(post.id) && replies.length >= 20) continue
      threads[rootId] = replies.includes(post.id)
        ? replies
        : [...replies, post.id]
    }
    const old = posts[post.id]
    if (old === undefined) {
      posts[post.id] = {
        ...post,
        firstSeenAt: batch.observedAt,
        lastSeenAt: batch.observedAt,
      }
      added += 1
    } else if (
      old.text !== post.text ||
      old.postedAt !== post.postedAt ||
      old.lastSeenAt !== batch.observedAt
    ) {
      posts[post.id] = {
        ...old,
        text: post.text,
        postedAt: post.postedAt,
        lastSeenAt: batch.observedAt,
      }
      updated += 1
    }
  }
  return { state: { ...state, posts, threads }, added, updated }
}

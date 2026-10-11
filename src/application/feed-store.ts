import { closeSync, existsSync, openSync, unlinkSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'

import {
  ImageDownloadError,
  parseImageDescriptors,
  saveImageFile,
  type ImageDescriptor,
} from './image-files.js'
import {
  FeedValidationError,
  ingestCaptures,
  normalizeHandles,
  parseCaptureBatch,
  type FeedState,
  type IngestResult,
} from '../domain/feed.js'

class FeedStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'FeedStoreError'
  }
}

interface CaptureEvent {
  readonly id: number
  readonly kind: 'post' | 'thread'
  readonly postId: string
  readonly author: string
  readonly title: string
  readonly replyCount: number
  readonly capturedAt: string
}

interface StoredImage {
  readonly mediaId: string
  readonly position: number
  readonly sourceUrl: string
  readonly localPath: string | null
  readonly mimeType: string | null
  readonly byteLength: number | null
  readonly sha256: string | null
  readonly status: 'saved' | 'failed'
  readonly error: string | null
}

type FeedArchive = FeedState & {
  readonly posts: Readonly<
    Record<string, StoredPost & { readonly images: readonly StoredImage[] }>
  >
}

interface StoredIngestResult extends IngestResult {
  readonly imagesSaved: number
  readonly imagesFailed: number
}

const POST_IMAGES_TABLE = `CREATE TABLE IF NOT EXISTS post_images (
  post_id TEXT NOT NULL REFERENCES posts(id),
  media_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 10),
  source_url TEXT NOT NULL,
  local_path TEXT,
  mime_type TEXT,
  byte_length INTEGER,
  sha256 TEXT,
  status TEXT NOT NULL CHECK (status IN ('saved', 'failed')),
  error TEXT,
  PRIMARY KEY (post_id, media_id)
)`
const POST_IMAGES_INDEX =
  'CREATE INDEX IF NOT EXISTS post_images_by_post ON post_images (post_id, position)'

export interface FeedStore {
  getState(): FeedState
  getArchive(): FeedArchive
  getEvents(limit: number): readonly CaptureEvent[]
  setHandles(value: unknown): Promise<readonly string[]>
  ingest(value: unknown): Promise<StoredIngestResult>
  close(): void
}

const SCHEMA = [
  'CREATE TABLE schema_info (version INTEGER NOT NULL CHECK (version = 1))',
  'INSERT INTO schema_info (version) VALUES (1)',
  `CREATE TABLE followed_handles (
    handle TEXT PRIMARY KEY,
    position INTEGER NOT NULL UNIQUE
  )`,
  `CREATE TABLE posts (
    id TEXT PRIMARY KEY,
    author TEXT NOT NULL,
    text TEXT NOT NULL,
    url TEXT NOT NULL,
    posted_at TEXT,
    thread_root_id TEXT REFERENCES posts(id),
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  )`,
  `CREATE TABLE thread_replies (
    root_id TEXT NOT NULL REFERENCES posts(id),
    reply_id TEXT NOT NULL REFERENCES posts(id),
    position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 19),
    PRIMARY KEY (root_id, reply_id),
    UNIQUE (root_id, position)
  )`,
  `CREATE TABLE capture_events (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('post', 'thread')),
    post_id TEXT NOT NULL REFERENCES posts(id),
    author TEXT NOT NULL,
    title TEXT NOT NULL,
    reply_count INTEGER NOT NULL,
    captured_at TEXT NOT NULL
  )`,
  POST_IMAGES_TABLE,
  POST_IMAGES_INDEX,
  'CREATE INDEX capture_events_by_time ON capture_events (captured_at DESC, id DESC)',
]

type StoredPost = FeedState['posts'][string]

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseState(value: unknown): FeedState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FeedValidationError('feed state must be a JSON object')
  }
  const input = value as Record<string, unknown>
  if (input['version'] !== 1) {
    throw new FeedValidationError('unsupported feed state version')
  }
  const followedHandles = normalizeHandles(input['followedHandles'])
  const posts = input['posts']
  const threads = input['threads']
  if (typeof posts !== 'object' || posts === null || Array.isArray(posts)) {
    throw new FeedValidationError('feed state posts must be an object')
  }
  if (
    typeof threads !== 'object' ||
    threads === null ||
    Array.isArray(threads)
  ) {
    throw new FeedValidationError('feed state threads must be an object')
  }
  return {
    version: 1,
    followedHandles,
    posts: posts as FeedState['posts'],
    threads: threads as FeedState['threads'],
  }
}

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.prepare('BEGIN IMMEDIATE').run()
  try {
    const result = operation()
    database.prepare('COMMIT').run()
    return result
  } catch (error: unknown) {
    database.prepare('ROLLBACK').run()
    throw error
  }
}

function title(post: StoredPost): string {
  return (
    post.text.replace(/\s+/g, ' ').trim().slice(0, 160) ||
    `Post by @${post.author}`
  )
}

function insertEvent(
  database: DatabaseSync,
  kind: CaptureEvent['kind'],
  post: StoredPost,
  replyCount: number,
  capturedAt: string,
): void {
  database
    .prepare(
      `
    INSERT INTO capture_events (kind, post_id, author, title, reply_count, captured_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
    )
    .run(kind, post.id, post.author, title(post), replyCount, capturedAt)
}

function insertPost(database: DatabaseSync, post: StoredPost): void {
  database
    .prepare(
      `
    INSERT INTO posts (
      id, author, text, url, posted_at, thread_root_id, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      text = excluded.text,
      posted_at = excluded.posted_at,
      last_seen_at = excluded.last_seen_at
  `,
    )
    .run(
      post.id,
      post.author,
      post.text,
      post.url,
      post.postedAt,
      post.threadRootId,
      post.firstSeenAt,
      post.lastSeenAt,
    )
}

function insertHandles(
  database: DatabaseSync,
  handles: readonly string[],
): void {
  const insert = database.prepare(
    'INSERT INTO followed_handles (handle, position) VALUES (?, ?)',
  )
  handles.forEach((handle, position) => insert.run(handle, position))
}

function insertThreads(database: DatabaseSync, state: FeedState): void {
  const insert = database.prepare(`
    INSERT INTO thread_replies (root_id, reply_id, position) VALUES (?, ?, ?)
  `)
  for (const [rootId, replies] of Object.entries(state.threads)) {
    replies.forEach((replyId, position) =>
      insert.run(rootId, replyId, position),
    )
  }
}

function populate(database: DatabaseSync, state: FeedState): void {
  transaction(database, () => {
    insertHandles(database, state.followedHandles)
    const posts = Object.values(state.posts)
    for (const post of posts.filter((item) => item.threadRootId === null))
      insertPost(database, post)
    for (const post of posts.filter((item) => item.threadRootId !== null))
      insertPost(database, post)
    insertThreads(database, state)
    for (const post of posts) {
      if (post.threadRootId === null)
        insertEvent(database, 'post', post, 0, post.firstSeenAt)
    }
    for (const [rootId, replies] of Object.entries(state.threads)) {
      const root = state.posts[rootId]
      if (root !== undefined && replies.length > 0) {
        const last = state.posts[replies[replies.length - 1] ?? '']
        insertEvent(
          database,
          'thread',
          root,
          replies.length,
          last?.firstSeenAt ?? root.firstSeenAt,
        )
      }
    }
  })
}

function createDatabase(file: string, state: FeedState): void {
  let database: DatabaseSync | undefined
  let created = false
  try {
    closeSync(openSync(file, 'wx', 0o600))
    created = true
    database = new DatabaseSync(file)
    for (const statement of SCHEMA) database.prepare(statement).run()
    populate(database, state)
    database.close()
  } catch (error: unknown) {
    if (database !== undefined) database.close()
    if (created) unlinkSync(file)
    throw new FeedStoreError(
      `cannot initialize feed state at ${file}: ${detail(error)}`,
      { cause: error },
    )
  }
}

export async function initializeFeedFile(file: string): Promise<void> {
  createDatabase(file, {
    version: 1,
    followedHandles: [],
    posts: {},
    threads: {},
  })
}

export async function migrateFeedFile(
  sourceFile: string,
  stateFile: string,
): Promise<readonly string[]> {
  let state: FeedState
  try {
    state = parseState(
      JSON.parse(await readFile(sourceFile, 'utf8')) as unknown,
    )
  } catch (error: unknown) {
    throw new FeedStoreError(
      `cannot read legacy feed state at ${sourceFile}: ${detail(error)}`,
      { cause: error },
    )
  }
  createDatabase(stateFile, state)
  return state.followedHandles
}

interface PostRow {
  readonly id: string
  readonly author: string
  readonly text: string
  readonly url: string
  readonly posted_at: string | null
  readonly thread_root_id: string | null
  readonly first_seen_at: string
  readonly last_seen_at: string
}

function readState(database: DatabaseSync): FeedState {
  const schema = database.prepare('SELECT version FROM schema_info').get()
  if (schema?.['version'] !== 1)
    throw new FeedValidationError('unsupported feed state version')
  const followedHandles = database
    .prepare('SELECT handle FROM followed_handles ORDER BY position')
    .all()
    .map((row) => String(row['handle']))
  const posts: Record<string, StoredPost> = {}
  for (const row of database
    .prepare('SELECT * FROM posts')
    .all() as unknown as PostRow[]) {
    posts[row.id] = {
      id: row.id,
      author: row.author,
      text: row.text,
      url: row.url,
      postedAt: row.posted_at,
      threadRootId: row.thread_root_id,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
    }
  }
  const threads: Record<string, string[]> = {}
  for (const row of database
    .prepare(
      'SELECT root_id, reply_id FROM thread_replies ORDER BY root_id, position',
    )
    .all()) {
    const rootId = String(row['root_id'])
    const replyId = String(row['reply_id'])
    const replies = threads[rootId] ?? []
    replies.push(replyId)
    threads[rootId] = replies
  }
  return { version: 1, followedHandles, posts, threads }
}

function readArchive(database: DatabaseSync, state: FeedState): FeedArchive {
  const images: Record<string, StoredImage[]> = {}
  for (const row of database
    .prepare('SELECT * FROM post_images ORDER BY post_id, position')
    .all()) {
    const postId = String(row['post_id'])
    const existing = images[postId] ?? []
    existing.push({
      mediaId: String(row['media_id']),
      position: Number(row['position']),
      sourceUrl: String(row['source_url']),
      localPath: row['local_path'] === null ? null : String(row['local_path']),
      mimeType: row['mime_type'] === null ? null : String(row['mime_type']),
      byteLength:
        row['byte_length'] === null ? null : Number(row['byte_length']),
      sha256: row['sha256'] === null ? null : String(row['sha256']),
      status: row['status'] as StoredImage['status'],
      error: row['error'] === null ? null : String(row['error']),
    })
    images[postId] = existing
  }
  const posts: Record<
    string,
    StoredPost & { readonly images: readonly StoredImage[] }
  > = {}
  for (const [postId, post] of Object.entries(state.posts)) {
    posts[postId] = { ...post, images: images[postId] ?? [] }
  }
  return { ...state, posts }
}

interface ImageRequest {
  readonly postId: string
  readonly author: string
  readonly descriptor: ImageDescriptor
}

function requestedImages(
  value: unknown,
  batch: ReturnType<typeof parseCaptureBatch>,
  state: FeedState,
): readonly ImageRequest[] {
  const rawPosts = (value as { posts: unknown[] }).posts
  const requests = new Map<string, ImageRequest>()
  batch.posts.forEach((post, index) => {
    const raw = rawPosts[index] as Record<string, unknown>
    const descriptors = parseImageDescriptors(
      raw['images'],
      post.threadRootId === null,
    )
    const stored = state.posts[post.id]
    if (
      stored === undefined ||
      stored.author !== post.author ||
      stored.threadRootId !== null
    )
      return
    for (const descriptor of descriptors) {
      requests.set(`${post.id}:${descriptor.mediaId}`, {
        postId: post.id,
        author: stored.author,
        descriptor,
      })
    }
  })
  return [...requests.values()]
}

function writeImageRecord(
  database: DatabaseSync,
  request: ImageRequest,
  image: StoredImage,
): void {
  database
    .prepare(
      `
    INSERT INTO post_images (
      post_id, media_id, position, source_url, local_path, mime_type,
      byte_length, sha256, status, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(post_id, media_id) DO UPDATE SET
      position = excluded.position,
      source_url = excluded.source_url,
      local_path = excluded.local_path,
      mime_type = excluded.mime_type,
      byte_length = excluded.byte_length,
      sha256 = excluded.sha256,
      status = excluded.status,
      error = excluded.error
  `,
    )
    .run(
      request.postId,
      request.descriptor.mediaId,
      image.position,
      image.sourceUrl,
      image.localPath,
      image.mimeType,
      image.byteLength,
      image.sha256,
      image.status,
      image.error,
    )
}

export async function openFeedStore(
  file: string,
  options?: { readonly imageRoot?: string; readonly fetchImage?: typeof fetch },
): Promise<FeedStore> {
  if (!existsSync(file)) {
    throw new FeedStoreError(
      `cannot open feed state at ${file}: file does not exist`,
    )
  }
  let database: DatabaseSync | undefined
  let state: FeedState
  try {
    database = new DatabaseSync(file, { timeout: 5000 })
    database.prepare(POST_IMAGES_TABLE).run()
    database.prepare(POST_IMAGES_INDEX).run()
    database
      .prepare(
        'CREATE INDEX IF NOT EXISTS capture_events_by_time ON capture_events (captured_at DESC, id DESC)',
      )
      .run()
    state = readState(database)
  } catch (error: unknown) {
    if (database !== undefined) database.close()
    throw new FeedStoreError(
      `cannot open feed state at ${file}: ${detail(error)}`,
      { cause: error },
    )
  }
  const db = database
  const inFlight = new Map<string, Promise<'saved' | 'failed'>>()
  const fetchImage = options?.fetchImage ?? fetch
  async function processImage(
    request: ImageRequest,
  ): Promise<'saved' | 'failed' | 'skipped'> {
    const existing = db
      .prepare(
        'SELECT status, local_path FROM post_images WHERE post_id = ? AND media_id = ?',
      )
      .get(request.postId, request.descriptor.mediaId)
    if (
      existing?.['status'] === 'saved' &&
      typeof existing['local_path'] === 'string' &&
      existsSync(existing['local_path'])
    ) {
      return 'skipped'
    }
    const key = `${request.postId}:${request.descriptor.mediaId}`
    const pending = inFlight.get(key)
    if (pending !== undefined) {
      await pending
      return 'skipped'
    }
    const task = (async (): Promise<'saved' | 'failed'> => {
      const imageRoot = options?.imageRoot
      if (imageRoot === undefined) {
        throw new FeedStoreError('image directory is not configured')
      }
      let saved: Awaited<ReturnType<typeof saveImageFile>>
      try {
        saved = await saveImageFile(request.descriptor, {
          imageRoot,
          handle: request.author,
          postId: request.postId,
          fetchImage,
        })
      } catch (error: unknown) {
        if (!(error instanceof ImageDownloadError)) throw error
        writeImageRecord(db, request, {
          mediaId: request.descriptor.mediaId,
          position: request.descriptor.position,
          sourceUrl: request.descriptor.url,
          localPath: null,
          mimeType: null,
          byteLength: null,
          sha256: null,
          status: 'failed',
          error: error.message.slice(0, 500),
        })
        return 'failed'
      }
      writeImageRecord(db, request, {
        mediaId: request.descriptor.mediaId,
        position: request.descriptor.position,
        sourceUrl: request.descriptor.url,
        localPath: saved.localPath,
        mimeType: saved.mimeType,
        byteLength: saved.byteLength,
        sha256: saved.sha256,
        status: 'saved',
        error: null,
      })
      return 'saved'
    })()
    inFlight.set(key, task)
    try {
      return await task
    } finally {
      inFlight.delete(key)
    }
  }
  return {
    getState: () => state,
    getArchive: () => readArchive(db, state),
    getEvents: (limit: number) =>
      db
        .prepare(
          `
      SELECT id, kind, post_id, author, title, reply_count, captured_at
      FROM capture_events ORDER BY captured_at DESC, id DESC LIMIT ?
    `,
        )
        .all(limit)
        .map((row) => ({
          id: Number(row['id']),
          kind: row['kind'] as CaptureEvent['kind'],
          postId: String(row['post_id']),
          author: String(row['author']),
          title: String(row['title']),
          replyCount: Number(row['reply_count']),
          capturedAt: String(row['captured_at']),
        })),
    setHandles: async (value: unknown) => {
      const followedHandles = normalizeHandles(value)
      transaction(db, () => {
        db.prepare('DELETE FROM followed_handles').run()
        insertHandles(db, followedHandles)
      })
      state = { ...state, followedHandles }
      return followedHandles
    },
    ingest: async (value: unknown) => {
      const batch = parseCaptureBatch(value)
      const result = ingestCaptures(state, batch)
      const images = requestedImages(value, batch, result.state)
      if (images.length > 0 && options?.imageRoot === undefined) {
        throw new FeedStoreError('image directory is not configured')
      }
      transaction(db, () => {
        const writtenIds = new Set<string>()
        for (const captured of batch.posts) {
          if (writtenIds.has(captured.id)) continue
          writtenIds.add(captured.id)
          const next = result.state.posts[captured.id]
          if (next !== undefined && next !== state.posts[captured.id]) {
            insertPost(db, next)
            if (
              next.threadRootId === null &&
              state.posts[captured.id] === undefined
            ) {
              insertEvent(db, 'post', next, 0, batch.observedAt)
            }
          }
        }
        const insertReply = db.prepare(`
          INSERT INTO thread_replies (root_id, reply_id, position) VALUES (?, ?, ?)
        `)
        for (const [rootId, replies] of Object.entries(result.state.threads)) {
          const previous = state.threads[rootId] ?? []
          if (replies.length === previous.length) continue
          replies.forEach((replyId, position) => {
            if (!previous.includes(replyId))
              insertReply.run(rootId, replyId, position)
          })
          const root = result.state.posts[rootId]
          if (root !== undefined)
            insertEvent(db, 'thread', root, replies.length, batch.observedAt)
        }
      })
      state = result.state
      let imagesSaved = 0
      let imagesFailed = 0
      for (const image of images) {
        const outcome = await processImage(image)
        if (outcome === 'saved') imagesSaved += 1
        if (outcome === 'failed') imagesFailed += 1
      }
      return { ...result, imagesSaved, imagesFailed }
    },
    close: () => db.close(),
  }
}

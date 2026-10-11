import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  initializeFeedFile,
  openFeedStore,
} from '../../src/application/feed-store.js'
import {
  ImageDownloadError,
  saveImageFile,
} from '../../src/application/image-files.js'

const observedAt = '2026-10-11T12:00:00.000Z'
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff])
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const webp = Buffer.from('RIFF\0\0\0\0WEBP', 'binary')
const avif = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypavif', 'ascii'),
])
const avis = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypavis', 'ascii'),
])

interface ImageMetadata {
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

function post(
  id: string,
  author: string,
  images: readonly Record<string, unknown>[] = [],
  threadRootId: string | null = null,
) {
  return {
    id,
    author,
    text: `post ${id}`,
    url: `https://x.com/${author}/status/${id}`,
    postedAt: null,
    threadRootId,
    images,
  }
}

function image(mediaId: string, position = 1) {
  return {
    url: `https://pbs.twimg.com/media/${mediaId}?format=jpg&name=large`,
    mediaId,
    position,
  }
}

function response(
  body: ConstructorParameters<typeof Response>[0] = jpeg,
  options: {
    readonly contentType?: string | null
    readonly contentLength?: number | string
    readonly redirected?: boolean
    readonly status?: number
    readonly url?: string
  } = {},
): Response {
  const headers = new Headers()
  if (options.contentType !== null)
    headers.set('content-type', options.contentType ?? 'image/jpeg')
  if (options.contentLength !== undefined)
    headers.set('content-length', String(options.contentLength))
  const value = new Response(body, { status: options.status ?? 200, headers })
  Object.defineProperties(value, {
    redirected: { value: options.redirected ?? false },
    url: {
      value:
        options.url ??
        'https://pbs.twimg.com/media/TestImage?format=jpg&name=large',
    },
  })
  return value
}

function downloaderOptions(
  imageRoot: string,
  fetchImage: typeof fetch,
  overrides: { readonly handle?: string; readonly postId?: string } = {},
) {
  return {
    imageRoot,
    handle: overrides.handle ?? 'example_user',
    postId: overrides.postId ?? '900',
    fetchImage,
  }
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'xlog-images-'))
  const file = join(dir, 'state.db')
  const imageRoot = join(dir, 'media')
  await initializeFeedFile(file)
  const seed = await openFeedStore(file)
  await seed.setHandles(['example_user'])
  seed.close()
  return { dir, file, imageRoot }
}

function absoluteImagePath(imageRoot: string, localPath: string): string {
  return isAbsolute(localPath) ? localPath : resolve(imageRoot, localPath)
}

async function filesBelow(directory: string): Promise<readonly string[]> {
  try {
    return await readdir(directory, { recursive: true })
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return []
    throw error
  }
}

function imagesFor(
  archive: ReturnType<Awaited<ReturnType<typeof openFeedStore>>['getArchive']>,
  postId: string,
): readonly ImageMetadata[] {
  const value = archive.posts[postId]?.images
  if (!Array.isArray(value))
    throw new Error(`missing images for post ${postId}`)
  return value as readonly ImageMetadata[]
}

describe('image downloader', () => {
  it.each([
    ['image/jpeg', 'jpg', jpeg],
    ['image/png', 'png', png],
    ['image/webp', 'webp', webp],
    ['image/avif', 'avif', avif],
    ['image/avif', 'avif', avis],
  ] as const)(
    'saves %s only when its file signature matches',
    async (mimeType, extension, bytes) => {
      const { imageRoot } = await setup()
      const descriptor = image(`Valid_${extension}`)
      const fetchImage = vi.fn<typeof fetch>().mockImplementation((input) =>
        Promise.resolve(
          response(bytes, {
            contentType: ` ${mimeType.toUpperCase()} ; charset=binary`,
            contentLength: bytes.byteLength,
            url: String(input),
          }),
        ),
      )

      const saved = await saveImageFile(
        descriptor,
        downloaderOptions(imageRoot, fetchImage),
      )

      expect(fetchImage).toHaveBeenCalledWith(descriptor.url, {
        redirect: 'manual',
        signal: expect.any(AbortSignal),
      })
      const urlHash = createHash('sha256').update(descriptor.url).digest('hex')
      expect(saved).toEqual({
        localPath: expect.stringMatching(
          new RegExp(`Valid_${extension}-1-${urlHash}\\.${extension}$`),
        ),
        mimeType,
        byteLength: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })
      await expect(readFile(saved.localPath)).resolves.toEqual(
        Buffer.from(bytes),
      )
      await expect(
        readdir(join(imageRoot, 'example_user', '900')),
      ).resolves.toEqual([basename(saved.localPath)])
    },
  )

  it.each([
    ['image/jpeg', Uint8Array.from([0x00, 0xd8, 0xff])],
    ['image/jpeg', Uint8Array.from([0xff, 0x00, 0xff])],
    ['image/jpeg', Uint8Array.from([0xff, 0xd8, 0x00])],
    ['image/jpeg', Uint8Array.from([0xff, 0xd8])],
    [
      'image/png',
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x00]),
    ],
    ['image/webp', Buffer.from('NOPE\0\0\0\0WEBP', 'binary')],
    ['image/webp', Buffer.from('RIFF\0\0\0\0NOPE', 'binary')],
    ['image/webp', Buffer.from('RIFF\0\0\0WEBP', 'binary')],
    [
      'image/avif',
      Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00, 0x18]),
        Buffer.from('nopeavif', 'ascii'),
      ]),
    ],
    [
      'image/avif',
      Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00, 0x18]),
        Buffer.from('ftypheic', 'ascii'),
      ]),
    ],
    ['image/avif', Buffer.from('\0\0\0\u0018ftypavi', 'binary')],
  ] as const)(
    'rejects bytes that do not match the declared %s type',
    async (contentType, bytes) => {
      const { imageRoot } = await setup()
      const descriptor = image('BadSignature')
      const fetchImage = vi
        .fn<typeof fetch>()
        .mockImplementation((input) =>
          Promise.resolve(response(bytes, { contentType, url: String(input) })),
        )

      await expect(
        saveImageFile(descriptor, downloaderOptions(imageRoot, fetchImage)),
      ).rejects.toThrow(`does not match ${contentType}`)
      await expect(filesBelow(imageRoot)).resolves.toEqual([])
    },
  )

  it('accepts an image exactly at the 10 MiB boundary', async () => {
    const { imageRoot } = await setup()
    const bytes = Buffer.alloc(10 * 1024 * 1024)
    bytes.set(jpeg)
    const descriptor = image('Boundary')
    const fetchImage = vi.fn<typeof fetch>().mockImplementation((input) =>
      Promise.resolve(
        response(bytes, {
          contentLength: bytes.byteLength,
          url: String(input),
        }),
      ),
    )

    const saved = await saveImageFile(
      descriptor,
      downloaderOptions(imageRoot, fetchImage),
    )

    expect(saved.byteLength).toBe(10 * 1024 * 1024)
    await expect(readFile(saved.localPath)).resolves.toHaveLength(
      10 * 1024 * 1024,
    )
  })

  it.each([
    {
      name: 'a successful non-200 response',
      fetch: (url: string) =>
        Promise.resolve(response(jpeg, { status: 201, url })),
      message: 'returned HTTP 201',
    },
    {
      name: 'an invalid Content-Length',
      fetch: (url: string) =>
        Promise.resolve(response(jpeg, { contentLength: 'unknown', url })),
      message: 'exceeds the 10 MiB limit',
    },
    {
      name: 'a missing Content-Type',
      fetch: (url: string) =>
        Promise.resolve(response(jpeg, { contentType: null, url })),
      message: 'unsupported content type',
    },
    {
      name: 'an unsupported image Content-Type',
      fetch: (url: string) =>
        Promise.resolve(response(jpeg, { contentType: 'image/gif', url })),
      message: 'unsupported content type',
    },
    {
      name: 'a missing response body',
      fetch: (url: string) => Promise.resolve(response(null, { url })),
      message: 'has no body',
    },
  ])('rejects $name', async ({ fetch, message }) => {
    const { imageRoot } = await setup()
    const descriptor = image('BadResponse')
    const fetchImage = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation((input) => fetch(String(input)))

    await expect(
      saveImageFile(descriptor, downloaderOptions(imageRoot, fetchImage)),
    ).rejects.toThrow(message)
    await expect(filesBelow(imageRoot)).resolves.toEqual([])
  })

  it('wraps network failures with image context and preserves the cause', async () => {
    const { imageRoot } = await setup()
    const descriptor = image('Offline')
    const cause = new Error('socket closed')
    const fetchImage = vi.fn<typeof fetch>().mockRejectedValue(cause)

    await expect(
      saveImageFile(descriptor, downloaderOptions(imageRoot, fetchImage)),
    ).rejects.toMatchObject({
      name: 'ImageDownloadError',
      message: 'cannot fetch image Offline',
      cause,
    })
  })

  it('wraps response stream failures with image context', async () => {
    const { imageRoot } = await setup()
    const descriptor = image('BrokenStream')
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('stream interrupted'))
      },
    })
    const fetchImage = vi
      .fn<typeof fetch>()
      .mockImplementation((input) =>
        Promise.resolve(response(body, { url: String(input) })),
      )

    await expect(
      saveImageFile(descriptor, downloaderOptions(imageRoot, fetchImage)),
    ).rejects.toMatchObject({
      name: 'ImageDownloadError',
      message: 'cannot read image BrokenStream',
      cause: expect.any(Error),
    })
  })

  it('reports filesystem failures without leaving a partial image', async () => {
    const { imageRoot } = await setup()
    await writeFile(imageRoot, 'directory path is occupied by a file')
    const descriptor = image('DiskFailure')
    const fetchImage = vi
      .fn<typeof fetch>()
      .mockImplementation((input) =>
        Promise.resolve(response(jpeg, { url: String(input) })),
      )

    await expect(
      saveImageFile(descriptor, downloaderOptions(imageRoot, fetchImage)),
    ).rejects.toBeInstanceOf(ImageDownloadError)
    await expect(readFile(imageRoot, 'utf8')).resolves.toBe(
      'directory path is occupied by a file',
    )
  })

  it('removes its temporary file when the final rename fails', async () => {
    const { imageRoot } = await setup()
    const descriptor = image('RenameFailure')
    const urlHash = createHash('sha256').update(descriptor.url).digest('hex')
    const directory = join(imageRoot, 'example_user', '900')
    const destination = join(directory, `RenameFailure-1-${urlHash}.jpg`)
    await mkdir(destination, { recursive: true })
    const fetchImage = vi
      .fn<typeof fetch>()
      .mockImplementation((input) =>
        Promise.resolve(response(jpeg, { url: String(input) })),
      )

    await expect(
      saveImageFile(descriptor, downloaderOptions(imageRoot, fetchImage)),
    ).rejects.toThrow('cannot save image RenameFailure')
    await expect(readdir(directory)).resolves.toEqual([basename(destination)])
  })
})

describe('feed image files', () => {
  it('saves a root-post image below its handle and persists its metadata', async () => {
    const { file, imageRoot } = await setup()
    const fetchImage = vi
      .fn<typeof fetch>()
      .mockImplementation((input) =>
        Promise.resolve(response(jpeg, { url: String(input) })),
      )
    const store = await openFeedStore(file, { imageRoot, fetchImage })

    await expect(
      store.ingest({
        posts: [post('100', 'example_user', [image('MediaABC')])],
        observedAt,
      }),
    ).resolves.toMatchObject({
      added: 1,
      updated: 0,
      imagesSaved: 1,
      imagesFailed: 0,
    })

    const saved = imagesFor(store.getArchive(), '100')[0]
    expect(saved).toMatchObject({
      mediaId: 'MediaABC',
      position: 1,
      sourceUrl: 'https://pbs.twimg.com/media/MediaABC?format=jpg&name=large',
      mimeType: 'image/jpeg',
      byteLength: jpeg.byteLength,
      status: 'saved',
      error: null,
    })
    expect(saved?.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(saved?.localPath).toEqual(expect.any(String))
    const localPath = saved?.localPath
    if (localPath === null || localPath === undefined)
      throw new Error('expected a saved local path')
    const fullPath = absoluteImagePath(imageRoot, localPath)
    const pathWithinRoot = relative(imageRoot, fullPath)
    expect(pathWithinRoot.startsWith(`example_user${sep}100${sep}`)).toBe(true)
    expect(basename(fullPath)).toMatch(/^MediaABC-1-[a-f0-9]+\.jpg$/)
    await expect(readFile(fullPath)).resolves.toEqual(Buffer.from(jpeg))

    store.close()
    const reopened = await openFeedStore(file, {
      imageRoot,
      fetchImage: vi.fn<typeof fetch>(),
    })
    expect(imagesFor(reopened.getArchive(), '100')).toEqual([saved])
    reopened.close()
  })

  it('does not download or create a second file when the same image is observed again', async () => {
    const { file, imageRoot } = await setup()
    const fetchImage = vi
      .fn<typeof fetch>()
      .mockImplementation((input) =>
        Promise.resolve(response(jpeg, { url: String(input) })),
      )
    const store = await openFeedStore(file, { imageRoot, fetchImage })
    const capture = {
      posts: [post('101', 'example_user', [image('DuplicateMedia')])],
      observedAt,
    }

    await store.ingest(capture)
    await expect(
      store.ingest({
        ...capture,
        observedAt: '2026-10-11T12:01:00.000Z',
      }),
    ).resolves.toMatchObject({ imagesSaved: 0, imagesFailed: 0 })

    expect(fetchImage).toHaveBeenCalledTimes(1)
    const saved = imagesFor(store.getArchive(), '101')
    expect(saved).toHaveLength(1)
    const localPath = saved[0]?.localPath
    if (localPath === null || localPath === undefined)
      throw new Error('expected a saved local path')
    await expect(
      readdir(join(imageRoot, 'example_user', '101')),
    ).resolves.toEqual([basename(localPath)])
    store.close()
  })

  it('retries a failed image record and replaces it with saved metadata', async () => {
    const { file, imageRoot } = await setup()
    const fetchImage = vi
      .fn<typeof fetch>()
      .mockImplementationOnce((input) =>
        Promise.resolve(
          response('not an image', {
            contentType: 'text/plain',
            url: String(input),
          }),
        ),
      )
      .mockImplementationOnce((input) =>
        Promise.resolve(response(jpeg, { url: String(input) })),
      )
    const store = await openFeedStore(file, { imageRoot, fetchImage })
    const capture = {
      posts: [post('102', 'example_user', [image('RetryMedia')])],
      observedAt,
    }

    await expect(store.ingest(capture)).resolves.toMatchObject({
      imagesSaved: 0,
      imagesFailed: 1,
    })
    expect(imagesFor(store.getArchive(), '102')).toEqual([
      expect.objectContaining({
        localPath: null,
        mimeType: null,
        byteLength: null,
        sha256: null,
        status: 'failed',
        error: expect.stringContaining('unsupported content type'),
      }),
    ])

    await expect(
      store.ingest({
        ...capture,
        observedAt: '2026-10-11T12:01:00.000Z',
      }),
    ).resolves.toMatchObject({ imagesSaved: 1, imagesFailed: 0 })
    expect(fetchImage).toHaveBeenCalledTimes(2)
    expect(imagesFor(store.getArchive(), '102')).toEqual([
      expect.objectContaining({
        localPath: expect.any(String),
        mimeType: 'image/jpeg',
        byteLength: jpeg.byteLength,
        sha256: createHash('sha256').update(jpeg).digest('hex'),
        status: 'saved',
        error: null,
      }),
    ])
    store.close()
  })

  it('persists network and filesystem failures as failed image metadata', async () => {
    const network = await setup()
    const networkFetch = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('connection reset'))
    const networkStore = await openFeedStore(network.file, {
      imageRoot: network.imageRoot,
      fetchImage: networkFetch,
    })

    await expect(
      networkStore.ingest({
        posts: [post('105', 'example_user', [image('NetworkFailure')])],
        observedAt,
      }),
    ).resolves.toMatchObject({ imagesSaved: 0, imagesFailed: 1 })
    expect(imagesFor(networkStore.getArchive(), '105')).toEqual([
      expect.objectContaining({
        status: 'failed',
        localPath: null,
        error: 'cannot fetch image NetworkFailure',
      }),
    ])
    networkStore.close()

    const disk = await setup()
    await writeFile(disk.imageRoot, 'occupied')
    const diskFetch = vi
      .fn<typeof fetch>()
      .mockImplementation((input) =>
        Promise.resolve(response(jpeg, { url: String(input) })),
      )
    const diskStore = await openFeedStore(disk.file, {
      imageRoot: disk.imageRoot,
      fetchImage: diskFetch,
    })

    await expect(
      diskStore.ingest({
        posts: [post('106', 'example_user', [image('DiskFailure')])],
        observedAt,
      }),
    ).resolves.toMatchObject({ imagesSaved: 0, imagesFailed: 1 })
    expect(imagesFor(diskStore.getArchive(), '106')).toEqual([
      expect.objectContaining({
        status: 'failed',
        localPath: null,
        error: 'cannot save image DiskFailure',
      }),
    ])
    diskStore.close()
  })

  it('fails before storing a post when image storage is not configured', async () => {
    const { file } = await setup()
    const store = await openFeedStore(file, {
      fetchImage: vi.fn<typeof fetch>(),
    })

    await expect(
      store.ingest({
        posts: [post('107', 'example_user', [image('NoDirectory')])],
        observedAt,
      }),
    ).rejects.toThrow('image directory is not configured')

    expect(store.getArchive().posts['107']).toBeUndefined()
    store.close()
  })

  it('downloads a saved image again when its referenced file is missing', async () => {
    const { file, imageRoot } = await setup()
    const fetchImage = vi
      .fn<typeof fetch>()
      .mockImplementation((input) =>
        Promise.resolve(response(jpeg, { url: String(input) })),
      )
    const store = await openFeedStore(file, { imageRoot, fetchImage })
    const capture = {
      posts: [post('103', 'example_user', [image('MissingFile')])],
      observedAt,
    }
    await store.ingest(capture)
    const firstPath = imagesFor(store.getArchive(), '103')[0]?.localPath
    if (firstPath === null || firstPath === undefined)
      throw new Error('expected the first image path')
    await unlink(firstPath)

    await expect(
      store.ingest({
        ...capture,
        observedAt: '2026-10-11T12:01:00.000Z',
      }),
    ).resolves.toMatchObject({ imagesSaved: 1, imagesFailed: 0 })

    expect(fetchImage).toHaveBeenCalledTimes(2)
    await expect(readFile(firstPath)).resolves.toEqual(Buffer.from(jpeg))
    store.close()
  })

  it('coalesces concurrent downloads of the same post image', async () => {
    const { file, imageRoot } = await setup()
    const fetchImage = vi
      .fn<typeof fetch>()
      .mockImplementation((input) =>
        Promise.resolve(response(jpeg, { url: String(input) })),
      )
    const store = await openFeedStore(file, { imageRoot, fetchImage })
    const capture = {
      posts: [post('104', 'example_user', [image('ConcurrentMedia')])],
      observedAt,
    }

    const results = await Promise.all([
      store.ingest(capture),
      store.ingest({
        ...capture,
        observedAt: '2026-10-11T12:01:00.000Z',
      }),
    ])

    expect(fetchImage).toHaveBeenCalledTimes(1)
    expect(
      results.reduce((total, result) => total + result.imagesSaved, 0),
    ).toBe(1)
    expect(
      results.reduce((total, result) => total + result.imagesFailed, 0),
    ).toBe(0)
    expect(imagesFor(store.getArchive(), '104')).toHaveLength(1)
    store.close()
  })

  it('uses collision-safe paths when posts and handles report the same media id', async () => {
    const { file, imageRoot } = await setup()
    let fetchCount = 0
    const fetchImage = vi.fn<typeof fetch>().mockImplementation((input) => {
      fetchCount += 1
      return Promise.resolve(
        response(Uint8Array.from([...jpeg, fetchCount]), {
          url: String(input),
        }),
      )
    })
    const store = await openFeedStore(file, { imageRoot, fetchImage })
    await store.setHandles(['example_user', 'another'])

    await expect(
      store.ingest({
        posts: [
          post('201', 'example_user', [image('SharedMedia')]),
          post('202', 'example_user', [image('SharedMedia')]),
          post('203', 'another', [image('SharedMedia')]),
        ],
        observedAt,
      }),
    ).resolves.toMatchObject({ imagesSaved: 3, imagesFailed: 0 })

    const archive = store.getArchive()
    const paths = ['201', '202', '203'].map((id) => {
      const localPath = imagesFor(archive, id)[0]?.localPath
      if (localPath === null || localPath === undefined)
        throw new Error(`expected a saved path for ${id}`)
      return absoluteImagePath(imageRoot, localPath)
    })
    expect(new Set(paths).size).toBe(3)
    expect(relative(imageRoot, paths[0] ?? '')).toContain(
      join('example_user', '201'),
    )
    expect(relative(imageRoot, paths[1] ?? '')).toContain(
      join('example_user', '202'),
    )
    expect(relative(imageRoot, paths[2] ?? '')).toContain(
      join('another', '203'),
    )
    await expect(
      Promise.all(paths.map((path) => readFile(path))),
    ).resolves.toEqual([
      Buffer.from([...jpeg, 1]),
      Buffer.from([...jpeg, 2]),
      Buffer.from([...jpeg, 3]),
    ])
    store.close()
  })

  it.each([
    {
      name: 'a non-image MIME type',
      makeResponse: (url: string) =>
        response('not an image', { contentType: 'text/plain', url }),
    },
    {
      name: 'a declared body larger than 10 MiB',
      makeResponse: (url: string) =>
        response(jpeg, {
          contentLength: 10 * 1024 * 1024 + 1,
          url,
        }),
    },
    {
      name: 'a redirect',
      makeResponse: (url: string) => response(jpeg, { redirected: true, url }),
    },
  ])(
    'records a failed image for $name while preserving the post',
    async ({ makeResponse }) => {
      const { file, imageRoot } = await setup()
      const fetchImage = vi
        .fn<typeof fetch>()
        .mockImplementation((input) =>
          Promise.resolve(makeResponse(String(input))),
        )
      const store = await openFeedStore(file, { imageRoot, fetchImage })

      await expect(
        store.ingest({
          posts: [post('300', 'example_user', [image('RejectedMedia')])],
          observedAt,
        }),
      ).resolves.toMatchObject({ added: 1, imagesSaved: 0, imagesFailed: 1 })

      expect(store.getArchive().posts['300']).toBeDefined()
      expect(imagesFor(store.getArchive(), '300')).toEqual([
        expect.objectContaining({
          mediaId: 'RejectedMedia',
          sourceUrl:
            'https://pbs.twimg.com/media/RejectedMedia?format=jpg&name=large',
          localPath: null,
          status: 'failed',
          error: expect.any(String),
        }),
      ])
      await expect(filesBelow(imageRoot)).resolves.toEqual([])
      store.close()
    },
  )

  it('rejects a streamed body that crosses the 10 MiB limit', async () => {
    const { file, imageRoot } = await setup()
    let chunks = 0
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024))
        chunks += 1
      },
      cancel() {
        cancelled = true
      },
    })
    const fetchImage = vi
      .fn<typeof fetch>()
      .mockImplementation((input) =>
        Promise.resolve(
          response(body, { contentType: 'image/png', url: String(input) }),
        ),
      )
    const store = await openFeedStore(file, { imageRoot, fetchImage })

    await expect(
      store.ingest({
        posts: [post('301', 'example_user', [image('TooLarge')])],
        observedAt,
      }),
    ).resolves.toMatchObject({ imagesSaved: 0, imagesFailed: 1 })
    expect(imagesFor(store.getArchive(), '301')[0]).toMatchObject({
      localPath: null,
      status: 'failed',
      error: expect.any(String),
    })
    expect(cancelled).toBe(true)
    store.close()
  })

  it('rejects non-pbs image hosts before fetching or mutating the archive', async () => {
    const { file, imageRoot } = await setup()
    const fetchImage = vi.fn<typeof fetch>()
    const store = await openFeedStore(file, { imageRoot, fetchImage })

    await expect(
      store.ingest({
        posts: [
          post('400', 'example_user', [
            {
              url: 'https://images.example.test/media/Hostile?format=jpg',
              mediaId: 'Hostile',
              position: 1,
            },
          ]),
        ],
        observedAt,
      }),
    ).rejects.toThrow(/image|pbs\.twimg\.com|host/i)

    expect(fetchImage).not.toHaveBeenCalled()
    expect(store.getArchive().posts['400']).toBeUndefined()
    store.close()
  })

  it('rejects image descriptors on replies and never downloads them', async () => {
    const { file, imageRoot } = await setup()
    const fetchImage = vi.fn<typeof fetch>()
    const store = await openFeedStore(file, { imageRoot, fetchImage })
    await store.ingest({
      posts: [post('500', 'example_user')],
      observedAt,
    })

    await expect(
      store.ingest({
        posts: [post('501', 'someone', [image('ReplyMedia')], '500')],
        observedAt: '2026-10-11T12:01:00.000Z',
      }),
    ).rejects.toThrow(/image|root|reply/i)

    expect(fetchImage).not.toHaveBeenCalled()
    expect(store.getArchive().posts['501']).toBeUndefined()
    store.close()
  })

  it('ignores images belonging to an unfollowed root post', async () => {
    const { file, imageRoot } = await setup()
    const fetchImage = vi.fn<typeof fetch>()
    const store = await openFeedStore(file, { imageRoot, fetchImage })

    await expect(
      store.ingest({
        posts: [post('600', 'stranger', [image('QuotedMedia')])],
        observedAt,
      }),
    ).resolves.toMatchObject({
      added: 0,
      updated: 0,
      imagesSaved: 0,
      imagesFailed: 0,
    })
    expect(fetchImage).not.toHaveBeenCalled()
    expect(store.getArchive().posts['600']).toBeUndefined()
    store.close()
  })
})

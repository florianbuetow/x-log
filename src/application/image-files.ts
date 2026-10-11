import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { FeedValidationError } from '../domain/feed.js'

export interface ImageDescriptor {
  readonly url: string
  readonly mediaId: string
  readonly position: number
}

export interface SavedImageFile {
  readonly localPath: string
  readonly mimeType: string
  readonly byteLength: number
  readonly sha256: string
}

export class ImageDownloadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ImageDownloadError'
  }
}

const MEDIA_PATH = /^\/media\/([A-Za-z0-9_-]{1,100})$/
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FeedValidationError('image descriptor must be an object')
  }
  return value as Record<string, unknown>
}

export function parseImageDescriptors(
  value: unknown,
  isRoot: boolean,
): readonly ImageDescriptor[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 10) {
    throw new FeedValidationError(
      'images must be an array of at most 10 images',
    )
  }
  if (!isRoot && value.length > 0) {
    throw new FeedValidationError('reply images are not supported')
  }
  const seenIds = new Set<string>()
  const seenPositions = new Set<number>()
  return value.map((candidate: unknown) => {
    const image = record(candidate)
    const mediaId = image['mediaId']
    const position = image['position']
    const source = image['url']
    if (
      typeof mediaId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(mediaId)
    ) {
      throw new FeedValidationError('image mediaId is invalid')
    }
    if (
      typeof position !== 'number' ||
      !Number.isInteger(position) ||
      position < 1 ||
      position > 10
    ) {
      throw new FeedValidationError(
        'image position must be an integer from 1 to 10',
      )
    }
    if (typeof source !== 'string') {
      throw new FeedValidationError('image URL must be a string')
    }
    let url: URL
    try {
      url = new URL(source)
    } catch {
      throw new FeedValidationError('image URL is invalid')
    }
    const path = url.pathname.match(MEDIA_PATH)
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'pbs.twimg.com' ||
      url.port !== '' ||
      url.username !== '' ||
      url.password !== '' ||
      url.hash !== '' ||
      path?.[1] !== mediaId
    ) {
      throw new FeedValidationError(
        'image URL must be a pbs.twimg.com media URL matching mediaId',
      )
    }
    if (seenIds.has(mediaId) || seenPositions.has(position)) {
      throw new FeedValidationError('duplicate image mediaId or position')
    }
    seenIds.add(mediaId)
    seenPositions.add(position)
    return { url: url.href, mediaId, position }
  })
}

function imageSignatureMatches(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === 'image/jpeg') {
    return (
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff
    )
  }
  if (mimeType === 'image/png') {
    return (
      bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    )
  }
  if (mimeType === 'image/webp') {
    return (
      bytes.length >= 12 &&
      bytes.toString('ascii', 0, 4) === 'RIFF' &&
      bytes.toString('ascii', 8, 12) === 'WEBP'
    )
  }
  if (mimeType === 'image/avif') {
    return (
      bytes.length >= 12 &&
      bytes.toString('ascii', 4, 8) === 'ftyp' &&
      ['avif', 'avis'].includes(bytes.toString('ascii', 8, 12))
    )
  }
  return false
}

export async function saveImageFile(
  descriptor: ImageDescriptor,
  options: {
    readonly imageRoot: string
    readonly handle: string
    readonly postId: string
    readonly fetchImage: typeof fetch
  },
): Promise<SavedImageFile> {
  let response: Response
  try {
    response = await options.fetchImage(descriptor.url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error: unknown) {
    throw new ImageDownloadError(`cannot fetch image ${descriptor.mediaId}`, {
      cause: error,
    })
  }
  if (response.redirected || !response.ok || response.status !== 200) {
    throw new ImageDownloadError(
      `image ${descriptor.mediaId} returned HTTP ${response.status}`,
    )
  }
  const mimeType =
    response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ??
    ''
  const extension = MIME_EXTENSIONS[mimeType]
  if (extension === undefined) {
    throw new ImageDownloadError(
      `image ${descriptor.mediaId} has unsupported content type`,
    )
  }
  const declaredLength = response.headers.get('content-length')
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_IMAGE_BYTES)
  ) {
    throw new ImageDownloadError(
      `image ${descriptor.mediaId} exceeds the 10 MiB limit`,
    )
  }
  if (response.body === null) {
    throw new ImageDownloadError(`image ${descriptor.mediaId} has no body`)
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      byteLength += next.value.byteLength
      if (byteLength > MAX_IMAGE_BYTES) {
        await reader.cancel()
        throw new ImageDownloadError(
          `image ${descriptor.mediaId} exceeds the 10 MiB limit`,
        )
      }
      chunks.push(next.value)
    }
  } catch (error: unknown) {
    if (error instanceof ImageDownloadError) throw error
    throw new ImageDownloadError(`cannot read image ${descriptor.mediaId}`, {
      cause: error,
    })
  }
  const bytes = Buffer.concat(chunks, byteLength)
  if (!imageSignatureMatches(bytes, mimeType)) {
    throw new ImageDownloadError(
      `image ${descriptor.mediaId} does not match ${mimeType}`,
    )
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const urlHash = createHash('sha256').update(descriptor.url).digest('hex')
  const filename = `${descriptor.mediaId}-${descriptor.position}-${urlHash}.${extension}`
  const directory = join(options.imageRoot, options.handle, options.postId)
  const localPath = join(directory, filename)
  const temporary = join(directory, `${filename}.${randomUUID()}.tmp`)
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
    await rename(temporary, localPath)
  } catch (error: unknown) {
    await unlink(temporary).catch(() => undefined)
    throw new ImageDownloadError(`cannot save image ${descriptor.mediaId}`, {
      cause: error,
    })
  }
  return { localPath, mimeType, byteLength, sha256 }
}

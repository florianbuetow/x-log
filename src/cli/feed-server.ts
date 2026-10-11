import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'

import { type FeedStore } from '../application/feed-store.js'
import { FeedValidationError, parseConfig } from '../domain/feed.js'

class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'RequestError'
  }
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(`${JSON.stringify(value)}\n`)
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new RequestError('Content-Type must be application/json', 415)
  }
  let text = ''
  for await (const chunk of request) {
    text += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    if (text.length > 1_000_000) {
      throw new RequestError('request body is too large', 413)
    }
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new RequestError('request body must be valid JSON', 400)
  }
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  store: FeedStore,
  port: number,
): Promise<void> {
  const host = request.headers.host
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    throw new RequestError('invalid Host header', 403)
  }
  const origin = request.headers.origin
  if (
    origin !== undefined &&
    !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)
  ) {
    throw new RequestError('browser origin is not allowed', 403)
  }
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
  const path = url.pathname
  if (request.method === 'GET' && path === '/api/config') {
    send(response, 200, { followedHandles: store.getState().followedHandles })
    return
  }
  if (request.method === 'GET' && path === '/api/status') {
    const state = store.getState()
    send(response, 200, {
      followedHandles: state.followedHandles,
      postCount: Object.keys(state.posts).length,
      threadCount: Object.keys(state.threads).length,
    })
    return
  }
  if (request.method === 'GET' && path === '/api/archive') {
    send(response, 200, store.getArchive())
    return
  }
  if (request.method === 'GET' && path === '/api/events') {
    const rawLimit = url.searchParams.get('limit')
    if (rawLimit !== null && !/^\d+$/.test(rawLimit)) {
      throw new RequestError('limit must be an integer from 1 to 100', 400)
    }
    const limit = rawLimit === null ? 100 : Number(rawLimit)
    if (limit < 1 || limit > 100) {
      throw new RequestError('limit must be an integer from 1 to 100', 400)
    }
    send(response, 200, {
      events: store.getEvents(limit),
      totalPosts: Object.keys(store.getState().posts).length,
    })
    return
  }
  if (request.method === 'PUT' && path === '/api/config') {
    if (request.headers['x-xlog-client'] !== 'extension') {
      throw new RequestError('missing extension client header', 403)
    }
    const handles = parseConfig(await readJson(request))
    send(response, 200, { followedHandles: await store.setHandles(handles) })
    return
  }
  if (request.method === 'POST' && path === '/api/captures') {
    if (request.headers['x-xlog-client'] !== 'extension') {
      throw new RequestError('missing extension client header', 403)
    }
    const result = await store.ingest(await readJson(request))
    send(response, 200, {
      added: result.added,
      updated: result.updated,
      imagesSaved: result.imagesSaved,
      imagesFailed: result.imagesFailed,
    })
    return
  }
  throw new RequestError('endpoint not found', 404)
}

export async function startFeedServer(
  store: FeedStore,
  port: number,
): Promise<Server> {
  let listeningPort = port
  const server = createServer((request, response) => {
    void handle(request, response, store, listeningPort).catch(
      (error: unknown) => {
        if (response.headersSent) {
          response.destroy(error instanceof Error ? error : undefined)
          return
        }
        if (error instanceof RequestError) {
          send(response, error.status, { error: error.message })
        } else if (error instanceof FeedValidationError) {
          send(response, 400, { error: error.message })
        } else {
          send(response, 500, {
            error: 'feed service failed to process request',
          })
        }
      },
    )
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new RequestError('feed service has no TCP address', 500)
    }
    listeningPort = address.port
    return server
  } catch (error: unknown) {
    throw new RequestError(
      `cannot listen on 127.0.0.1:${port}: ${error instanceof Error ? error.message : String(error)}`,
      500,
    )
  }
}

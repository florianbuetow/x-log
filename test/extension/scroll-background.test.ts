import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

type Listener = (...args: unknown[]) => unknown
interface Run {
  id: string
  tabId: number
  handle: string
  endsAt: number
  phase: string
}
interface Reply {
  ok: boolean
  error?: string
  data: { run: Run | null }
}
const popup = { url: 'chrome-extension://xlog/popup.html' }
const page = { url: 'https://x.com/example_user', tab: { id: 7 }, frameId: 0 }

function harness(session: Record<string, unknown> = {}) {
  const listeners: Record<string, Listener> = {}
  const updates: { tabId: number; url: string }[] = []
  const cancellations: { tabId: number; message: { id: string } }[] = []
  const badges: string[] = []
  let currentTime = 1_000_000
  let currentTab: { id: number } | undefined = { id: 7 }
  let failedNavigation = false
  let offline = false
  let sequence = 0
  const event = (name: string) => ({
    addListener: (listener: Listener) => {
      listeners[name] = listener
    },
  })
  const chrome = {
    runtime: {
      onMessage: event('message'),
      onInstalled: event('installed'),
      onStartup: event('startup'),
      getURL: (path: string) => `chrome-extension://xlog/${path}`,
    },
    tabs: {
      onRemoved: event('removed'),
      onActivated: event('activated'),
      onUpdated: event('updated'),
      query: async () => (currentTab ? [currentTab] : []),
      update: async (tabId: number, change: { url: string }) => {
        if (failedNavigation) throw new Error('Navigation failed')
        updates.push({ tabId, url: change.url })
      },
      sendMessage: async (tabId: number, message: { id: string }) => {
        cancellations.push({ tabId, message })
      },
    },
    storage: {
      session: {
        get: async (key: string) => ({ [key]: session[key] }),
        set: async (value: object) => {
          Object.assign(session, value)
        },
        remove: async (key: string) => {
          delete session[key]
        },
      },
      local: { get: async () => ({}), set: async () => undefined },
    },
    action: {
      setBadgeText: async ({ text }: { text: string }) => {
        badges.push(text)
      },
      setBadgeBackgroundColor: async () => undefined,
      setTitle: async () => undefined,
    },
  }
  runInNewContext(readFileSync('extension/background.js', 'utf8'), {
    chrome,
    URL,
    AbortSignal,
    crypto: { randomUUID: () => `run-${++sequence}` },
    Date: { now: () => currentTime },
    console: { warn: () => undefined },
    fetch: async (url: string) => {
      if (offline) throw new Error('offline')
      return new Response(
        JSON.stringify(
          url.endsWith('/api/config')
            ? { followedHandles: ['example_user', 'another'] }
            : { postCount: 52 },
        ),
        { status: 200 },
      )
    },
  })
  return {
    updates,
    badges,
    cancellations,
    session,
    send: (message: object, sender: object = popup) =>
      new Promise<Reply>((resolve) => {
        listeners['message']?.(message, sender, resolve)
      }),
    emit: (name: string, ...args: unknown[]) => listeners[name]?.(...args),
    advance: (milliseconds: number) => {
      currentTime += milliseconds
    },
    noTab: () => {
      currentTab = undefined
    },
    offline: () => {
      offline = true
    },
    failNavigation: () => {
      failedNavigation = true
    },
  }
}

describe('unreachable backend', () => {
  it('tells the user the backend server is not running and flags the badge', async () => {
    const h = harness()
    h.offline()
    expect(await h.send({ type: 'config:get' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('Backend server is not running'),
    })
    expect(h.badges).toContain('!')
  })
})

describe('profile navigation and scrolling handoff', () => {
  it('opens the chosen profile in the current tab without starting a run', async () => {
    const h = harness()
    h.offline()
    expect(
      await h.send({ type: 'profile:open', handle: 'another' }),
    ).toMatchObject({ ok: true, data: { run: null } })
    expect(h.updates).toEqual([{ tabId: 7, url: 'https://x.com/another' }])
    expect(h.session['scrollRun']).toBeUndefined()
  })

  it('hands a five-minute run to the correct top-frame document exactly once', async () => {
    const h = harness()
    const start = await h.send({ type: 'scroll:start', handle: 'example_user' })
    expect(start).toMatchObject({
      ok: true,
      data: {
        run: {
          tabId: 7,
          handle: 'example_user',
          phase: 'loading',
          endsAt: 1_300_000,
        },
      },
    })
    expect(h.updates).toEqual([{ tabId: 7, url: 'https://x.com/example_user' }])
    for (const wrong of [
      { ...page, tab: { id: 8 } },
      { ...page, url: 'https://x.com/another' },
      { ...page, frameId: 1 },
      { ...page, url: 'https://evil.example/example_user' },
    ])
      expect(
        await h.send(
          { type: 'scroll:ready', documentStartedAt: 1_000_001 },
          wrong,
        ),
      ).toMatchObject({
        data: { run: null },
      })
    const ready = await h.send(
      { type: 'scroll:ready', documentStartedAt: 1_000_001 },
      page,
    )
    expect(ready.data.run).toMatchObject({
      id: start.data.run?.id,
      phase: 'running',
    })
    expect(
      await h.send(
        { type: 'scroll:ready', documentStartedAt: 1_000_001 },
        page,
      ),
    ).toMatchObject({
      data: { run: null },
    })
  })

  it('retains pending state across worker restarts and expires it before a late page loads', async () => {
    const shared = {}
    const first = harness(shared)
    await first.send({ type: 'scroll:start', handle: 'example_user' })
    const restarted = harness(shared)
    expect(
      (await restarted.send({ type: 'scroll:status' })).data.run?.handle,
    ).toBe('example_user')
    restarted.advance(300_000)
    expect(
      await restarted.send(
        { type: 'scroll:ready', documentStartedAt: 1_000_001 },
        page,
      ),
    ).toMatchObject({
      data: { run: null },
    })
    expect(restarted.cancellations).toHaveLength(1)
  })

  it('rejects an old document ready message during same-profile navigation', async () => {
    const h = harness()
    await h.send({ type: 'scroll:start', handle: 'example_user' })
    for (const documentStartedAt of [undefined, NaN, 999_999]) {
      expect(
        await h.send({ type: 'scroll:ready', documentStartedAt }, page),
      ).toMatchObject({ data: { run: null } })
    }
    h.emit('updated', 7, { status: 'loading' })
    expect(
      await h.send(
        { type: 'scroll:ready', documentStartedAt: 1_000_001 },
        page,
      ),
    ).toMatchObject({ data: { run: { phase: 'running' } } })
    expect(h.cancellations).toHaveLength(0)
  })

  it('ignores stale or cross-tab stop notices and honors the current run notice', async () => {
    const h = harness()
    const first = (
      await h.send({ type: 'scroll:start', handle: 'example_user' })
    ).data.run!
    const second = (await h.send({ type: 'scroll:start', handle: 'another' }))
      .data.run!
    await h.send({ type: 'scroll:ended', id: first.id }, page)
    await h.send(
      { type: 'scroll:ended', id: second.id },
      { ...page, tab: { id: 8 } },
    )
    expect((await h.send({ type: 'scroll:status' })).data.run?.id).toBe(
      second.id,
    )
    await h.send({ type: 'scroll:ended', id: second.id }, page)
    expect((await h.send({ type: 'scroll:status' })).data.run).toBeNull()
  })

  it.each(['navigation', 'reload', 'switch', 'close', 'stop'])(
    'cancels the running tab on %s',
    async (reason) => {
      const h = harness()
      await h.send({ type: 'scroll:start', handle: 'example_user' })
      await h.send({ type: 'scroll:ready', documentStartedAt: 1_000_001 }, page)
      if (reason === 'navigation')
        h.emit('updated', 7, { url: 'https://x.com/home' })
      if (reason === 'reload') h.emit('updated', 7, { status: 'loading' })
      if (reason === 'switch') h.emit('activated', { tabId: 8 })
      if (reason === 'close') h.emit('removed', 7)
      if (reason === 'stop') await h.send({ type: 'scroll:stop' })
      expect((await h.send({ type: 'scroll:status' })).data.run).toBeNull()
      expect(h.cancellations).toHaveLength(1)
    },
  )

  it('does not start for an unfollowed handle, offline service, or missing current tab', async () => {
    const h = harness()
    expect(
      (await h.send({ type: 'scroll:start', handle: 'unfollowed' })).ok,
    ).toBe(false)
    expect((await h.send({ type: 'scroll:start', handle: '../home' })).ok).toBe(
      false,
    )
    h.noTab()
    expect((await h.send({ type: 'profile:open', handle: 'another' })).ok).toBe(
      false,
    )
    h.offline()
    expect(
      (await h.send({ type: 'scroll:start', handle: 'example_user' })).ok,
    ).toBe(false)
    expect(h.updates).toHaveLength(0)
  })

  it('clears the pending run if Chrome rejects navigation', async () => {
    const h = harness()
    h.failNavigation()
    expect(
      await h.send({ type: 'scroll:start', handle: 'example_user' }),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining('Navigation failed'),
    })
    expect(h.session['scrollRun']).toBeUndefined()
  })

  it('does not let content scripts start navigation or control another tab', async () => {
    const h = harness()
    for (const type of [
      'profile:open',
      'scroll:start',
      'scroll:stop',
      'scroll:status',
    ]) {
      expect((await h.send({ type, handle: 'example_user' }, page)).ok).toBe(
        false,
      )
    }
    expect(h.updates).toHaveLength(0)
  })
})

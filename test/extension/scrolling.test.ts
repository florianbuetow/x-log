import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface ScrollRun {
  readonly id: string
  readonly tabId: number
  readonly handle: string
  readonly endsAt: number
}

interface RuntimeMessage {
  readonly type?: string
  readonly id?: string
  readonly reason?: string
  readonly documentStartedAt?: number
}

interface Harness {
  readonly location: { href: string; pathname: string; origin: string }
  readonly distances: number[]
  readonly instantStops: { top: number; left: number; behavior: string }[]
  readonly messages: RuntimeMessage[]
  readonly document: FakeTarget & { visibilityState: string }
  readonly dispatchRuntime: (message: RuntimeMessage) => void
  readonly resolveCapture: (response: unknown) => void
  readonly resolveReady: (response: unknown) => void
  readonly handleLocationChange: () => void
  readonly applyConfig: (config: { followedHandles: string[] }) => void
  readonly state: () => { activeId: string | null; stopped: boolean }
  readonly invalidate: () => void
  readonly disconnected: () => boolean
}

class FakeTarget {
  readonly listeners = new Map<string, Set<(event: EventLike) => void>>()

  addEventListener(type: string, listener: (event: EventLike) => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(
    type: string,
    listener: (event: EventLike) => void,
  ): void {
    this.listeners.get(type)?.delete(listener)
  }

  dispatch(type: string, event: EventLike = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

interface EventLike {
  readonly key?: string
}

function renderedTweet(): object {
  const time = {
    closest: () => ({ href: 'https://x.com/example_user/status/123' }),
    getAttribute: () => '2026-10-11T12:00:00.000Z',
  }
  return {
    querySelectorAll: (selector: string) =>
      selector === 'time[datetime]' ? [time] : [],
    querySelector: () => ({ innerText: 'A visible post' }),
    getBoundingClientRect: () => ({
      width: 500,
      height: 100,
      top: 0,
      bottom: 100,
    }),
  }
}

function createHarness(options?: {
  readonly run?: ScrollRun | null
  readonly pendingCapture?: boolean
  readonly pendingReady?: boolean
  readonly captureFailure?: boolean
  readonly random?: () => number
}): Harness {
  const source = readFileSync('extension/content.js', 'utf8')
  const runtimeListeners: ((message: RuntimeMessage) => void)[] = []
  const messages: RuntimeMessage[] = []
  const captureResponders: ((response: unknown) => void)[] = []
  const readyResponders: ((response: unknown) => void)[] = []
  let invalidated = false
  let disconnected = false
  const documentTarget = new FakeTarget() as FakeTarget & {
    body?: { append: (node: FakeControl) => void }
    createElement?: () => FakeControl
    documentElement?: object
    querySelectorAll?: () => readonly object[]
    visibilityState: string
  }
  documentTarget.visibilityState = 'visible'
  documentTarget.documentElement = {}
  documentTarget.querySelectorAll = () => [renderedTweet()]
  documentTarget.createElement = () => new FakeControl()
  documentTarget.body = { append: (node) => (node.connected = true) }
  const windowTarget = new FakeTarget() as FakeTarget & {
    innerHeight: number
    scrollX: number
    scrollY: number
    scrollBy: (options: { top: number }) => void
    scrollTo: (options: { top: number; left: number; behavior: string }) => void
  }
  const distances: number[] = []
  const instantStops: { top: number; left: number; behavior: string }[] = []
  windowTarget.innerHeight = 1_000
  windowTarget.scrollX = 11
  windowTarget.scrollY = 22
  windowTarget.scrollBy = ({ top }) => distances.push(top)
  windowTarget.scrollTo = (scrollOptions) => instantStops.push(scrollOptions)
  const location = {
    href: 'https://x.com/example_user',
    pathname: '/example_user',
    origin: 'https://x.com',
  }
  const runtime = {
    onMessage: {
      addListener: (listener: (message: RuntimeMessage) => void) =>
        runtimeListeners.push(listener),
    },
    sendMessage: (
      message: RuntimeMessage,
      respond: (response: unknown) => void,
    ) => {
      if (invalidated) throw new Error('Extension context invalidated.')
      messages.push(message)
      if (message.type === 'config:get') {
        respond({ ok: true, data: { followedHandles: ['example_user'] } })
      } else if (message.type === 'scroll:ready') {
        if (options?.pendingReady) readyResponders.push(respond)
        else respond({ ok: true, data: { run: options?.run ?? null } })
      } else if (message.type === 'captures:post') {
        if (options?.pendingCapture) {
          captureResponders.push(respond)
        } else if (options?.captureFailure) {
          respond({ ok: false, error: 'save failed' })
        } else {
          respond({ ok: true, data: { imagesFailed: 0 } })
        }
      } else {
        respond({ ok: true, data: {} })
      }
    },
    get lastError() {
      if (invalidated) throw new Error('Extension context invalidated.')
      return undefined
    },
  }
  const math = Object.create(Math) as Math
  Object.defineProperty(math, 'random', {
    value: options?.random ?? Math.random,
  })
  const context = {
    chrome: { runtime },
    document: documentTarget,
    window: windowTarget,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    location,
    MutationObserver: class {
      observe(): void {}
      disconnect(): void {
        disconnected = true
      }
    },
    setTimeout,
    clearTimeout,
    console: { warn: () => undefined },
    performance: { timeOrigin: 999_000 },
    Date,
    Math: math,
    URL,
  }
  const script = runInNewContext(
    `${source}\n;({
      handleLocationChange,
      applyConfig,
      state: () => ({ activeId: activeScroll?.id ?? null, stopped }),
    })`,
    context,
  ) as {
    handleLocationChange: () => void
    applyConfig: (config: { followedHandles: string[] }) => void
    state: () => { activeId: string | null; stopped: boolean }
  }

  return {
    location,
    distances,
    instantStops,
    messages,
    document: documentTarget,
    dispatchRuntime: (message) => {
      for (const listener of runtimeListeners) listener(message)
    },
    resolveCapture: (response) => {
      const respond = captureResponders.shift()
      if (!respond) throw new Error('No capture is pending.')
      respond(response)
    },
    resolveReady: (response) => {
      const respond = readyResponders.shift()
      if (!respond) throw new Error('No ready request is pending.')
      respond(response)
    },
    handleLocationChange: script.handleLocationChange,
    applyConfig: script.applyConfig,
    state: script.state,
    invalidate: () => {
      invalidated = true
    },
    disconnected: () => disconnected,
  }
}

class FakeControl {
  type = ''
  textContent = ''
  connected = false
  readonly style = {}
  setAttribute(): void {}
  addEventListener(): void {}
  remove(): void {
    this.connected = false
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

function run(endsAt = Date.now() + 10 * 60_000): ScrollRun {
  return { id: 'run-1', tabId: 7, handle: 'example_user', endsAt }
}

function ended(messages: readonly RuntimeMessage[]): RuntimeMessage[] {
  return messages.filter((message) => message.type === 'scroll:ended')
}

describe('opt-in profile scrolling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-11T12:00:00.000Z'))
  })

  afterEach(() => vi.useRealTimers())

  it('does not start without a handed-off run', async () => {
    const harness = createHarness()
    await settle()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(harness.distances).toEqual([])
    expect(harness.instantStops).toEqual([])
    expect(
      harness.messages.find((message) => message.type === 'scroll:ready'),
    ).toMatchObject({ documentStartedAt: 999_000 })
    expect(harness.state().activeId).toBeNull()
    expect(ended(harness.messages)).toEqual([])

    harness.document.dispatch('mousedown')
    expect(harness.instantStops).toEqual([])
  })

  it('does not start a handed-off run after mouse input during initialization', async () => {
    const harness = createHarness({ pendingReady: true })
    await settle()
    harness.document.dispatch('pointerdown')
    harness.resolveReady({ ok: true, data: { run: run() } })
    await settle()

    expect(harness.distances).toEqual([])
    expect(harness.state().activeId).toBeNull()
    expect(ended(harness.messages).at(-1)?.reason).toBe('pointer')
  })

  it('uses varied bounded steps and enforces its local five-minute limit', async () => {
    const values = [0, 0, 0.5, 0.999, 0.999, 0.999]
    let index = 0
    const harness = createHarness({
      run: run(),
      random: () => values[index++ % values.length] ?? 0.5,
    })
    await settle()
    await vi.advanceTimersByTimeAsync(8_000)

    expect(new Set(harness.distances).size).toBeGreaterThan(1)
    expect(harness.distances.every((step) => step >= 350 && step <= 800)).toBe(
      true,
    )

    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(harness.state().activeId).toBeNull()
    expect(ended(harness.messages).at(-1)).toMatchObject({
      id: 'run-1',
      reason: 'deadline',
    })
  })

  it('stops on mouse input while a viewport capture is pending', async () => {
    const harness = createHarness({ run: run(), pendingCapture: true })
    await settle()
    harness.document.dispatch('mousedown')
    harness.resolveCapture({ ok: true, data: { imagesFailed: 0 } })
    await settle()

    expect(harness.distances).toEqual([])
    expect(ended(harness.messages)).toContainEqual({
      type: 'scroll:ended',
      id: 'run-1',
      reason: 'pointer',
    })
    expect(harness.instantStops).toEqual([
      { top: 22, left: 11, behavior: 'instant' },
    ])
  })

  it('stops when navigation leaves the exact profile', async () => {
    const harness = createHarness({ run: run() })
    await settle()
    harness.location.pathname = '/home'
    harness.location.href = 'https://x.com/home'
    harness.handleLocationChange()

    expect(harness.state().activeId).toBeNull()
    expect(ended(harness.messages).at(-1)?.reason).toBe('navigation')
  })

  it('stops instead of scrolling when capture fails', async () => {
    const harness = createHarness({ run: run(), captureFailure: true })
    await settle()

    expect(harness.distances).toEqual([])
    expect(harness.state().activeId).toBeNull()
    expect(ended(harness.messages).at(-1)?.reason).toBe('capture-failed')
  })

  it('accepts cancellation only for the active run', async () => {
    const harness = createHarness({ run: run() })
    await settle()
    harness.dispatchRuntime({ type: 'scroll:cancel', id: 'another-run' })
    expect(harness.state().activeId).toBe('run-1')

    harness.dispatchRuntime({ type: 'scroll:cancel', id: 'run-1' })
    expect(harness.state().activeId).toBeNull()
    expect(ended(harness.messages).at(-1)?.reason).toBe('cancelled')
  })

  it('stops if configuration no longer follows the active profile', async () => {
    const harness = createHarness({ run: run() })
    await settle()
    harness.applyConfig({ followedHandles: [] })

    expect(harness.state().activeId).toBeNull()
    expect(ended(harness.messages).at(-1)?.reason).toBe('unfollowed')
  })

  it('stops cleanly when the extension context is invalidated', async () => {
    const harness = createHarness({ run: run(), pendingCapture: true })
    await settle()
    expect(harness.distances).toEqual([])
    harness.invalidate()
    harness.resolveCapture({ ok: true, data: { imagesFailed: 0 } })
    await settle()
    expect(harness.state()).toEqual({ activeId: null, stopped: true })
    await vi.advanceTimersByTimeAsync(2_000)

    expect(harness.distances).toEqual([])
    expect(harness.state()).toEqual({ activeId: null, stopped: true })
    expect(harness.disconnected()).toBe(true)
  })
})

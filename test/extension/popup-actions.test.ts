import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

type Listener = (event: FakeEvent) => void

interface ExtensionMessage {
  readonly type: string
  readonly handle?: string
  readonly config?: { readonly followedHandles: readonly string[] }
}

interface ExtensionResponse {
  readonly ok: boolean
  readonly data?: unknown
  readonly error?: string
}

class FakeEvent {
  defaultPrevented = false

  constructor(readonly target: FakeElement) {}

  preventDefault(): void {
    this.defaultPrevented = true
  }
}

class FakeElement {
  readonly dataset: Record<string, string> = {}
  readonly attributes: Record<string, string> = {}
  readonly listeners = new Map<string, Listener[]>()
  children: FakeElement[] = []
  className = ''
  disabled = false
  hidden = false
  href = ''
  textContent = ''
  title = ''
  type = ''
  value = ''

  constructor(readonly tagName: string) {}

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  append(...children: FakeElement[]): void {
    this.children.push(...children)
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children = children
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value
  }

  closest(selector: string): FakeElement | null {
    if (
      selector === '[data-action][data-handle]' &&
      this.dataset['action'] !== undefined &&
      this.dataset['handle'] !== undefined
    ) {
      return this
    }
    return null
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  querySelectorAll(selector: string): FakeElement[] {
    const matches = (element: FakeElement): boolean =>
      selector === 'button' && element.tagName === 'button'
    return this.children.flatMap((child) => [
      ...(matches(child) ? [child] : []),
      ...child.querySelectorAll(selector),
    ])
  }

  dispatch(type: string, target: FakeElement = this): FakeEvent {
    const event = new FakeEvent(target)
    for (const listener of this.listeners.get(type) ?? []) listener(event)
    return event
  }
}

interface PopupHarness {
  readonly elements: Record<string, FakeElement>
  readonly messages: ExtensionMessage[]
  readonly confirmations: string[]
  readonly window: { closeCalls: number }
  flush: () => Promise<void>
}

function createHarness(
  overrides: Partial<Record<string, ExtensionResponse>> = {},
  confirmResult = true,
): PopupHarness {
  const source = readFileSync('extension/popup.js', 'utf8')
  const selectors = [
    '#add-form',
    '#handle',
    '#handles',
    '#empty',
    '#status',
    '#saved-count',
    '#open-log',
    '#scroll-status',
    '#stop-scroll',
  ]
  const elements = Object.fromEntries(
    selectors.map((selector) => [selector, new FakeElement('div')]),
  )
  const formButton = new FakeElement('button')
  elements['#add-form']?.append(formButton)
  const messages: ExtensionMessage[] = []
  const confirmations: string[] = []
  const window = {
    closeCalls: 0,
    addEventListener: () => undefined,
    close() {
      this.closeCalls += 1
    },
    confirm(message: string) {
      confirmations.push(message)
      return confirmResult
    },
  }
  const defaults: Record<string, ExtensionResponse> = {
    'config:get': {
      ok: true,
      data: { followedHandles: ['example_user', 'second_user'] },
    },
    'status:get': { ok: true, data: { postCount: 12 } },
    'scroll:status': { ok: true, data: { run: null } },
    'profile:open': { ok: true, data: {} },
    'scroll:start': { ok: true, data: {} },
    'scroll:stop': { ok: true, data: { run: null } },
  }

  runInNewContext(source, {
    chrome: {
      runtime: {
        sendMessage: (
          message: ExtensionMessage,
          respond: (response: ExtensionResponse) => void,
        ) => {
          messages.push(message)
          if (message.type === 'config:put') {
            respond({ ok: true, data: message.config })
            return
          }
          respond(
            overrides[message.type] ??
              defaults[message.type] ?? {
                ok: false,
                error: `Unexpected message: ${message.type}`,
              },
          )
        },
        lastError: undefined,
      },
      sidePanel: { open: () => Promise.resolve() },
      windows: { WINDOW_ID_CURRENT: -2 },
    },
    clearInterval: () => undefined,
    document: {
      createElement: (tagName: string) => new FakeElement(tagName),
      querySelector: (selector: string) => elements[selector],
    },
    setInterval: () => 1,
    URL,
    window,
  })

  return {
    elements,
    messages,
    confirmations,
    window,
    flush: async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

function actionFor(
  harness: PopupHarness,
  itemIndex: number,
  action: 'open' | 'scroll' | 'remove',
): FakeElement {
  const item = harness.elements['#handles']?.children[itemIndex]
  const candidates = [item?.children[0], ...(item?.children[1]?.children ?? [])]
  const result = candidates.find(
    (candidate) => candidate?.dataset['action'] === action,
  )
  if (!result) throw new Error(`Missing ${action} action in popup test.`)
  return result
}

describe('popup profile actions', () => {
  it('renders accessible profile links and opens the selected handle in the current tab', async () => {
    const harness = createHarness()
    await harness.flush()
    const link = actionFor(harness, 1, 'open')

    expect(link.tagName).toBe('a')
    expect(link.href).toBe('https://x.com/second_user')
    expect(link.title).toBe('Open @second_user in this tab')

    const event = harness.elements['#handles']?.dispatch('click', link)
    await harness.flush()

    expect(event?.defaultPrevented).toBe(true)
    expect(harness.messages).toContainEqual({
      type: 'profile:open',
      handle: 'second_user',
    })
    expect(harness.window.closeCalls).toBe(1)
  })

  it('starts scrolling for the selected handle and closes only after success', async () => {
    const successful = createHarness()
    await successful.flush()
    successful.elements['#handles']?.dispatch(
      'click',
      actionFor(successful, 0, 'scroll'),
    )
    await successful.flush()

    expect(successful.messages).toContainEqual({
      type: 'scroll:start',
      handle: 'example_user',
    })
    expect(successful.window.closeCalls).toBe(1)

    const failed = createHarness({
      'scroll:start': { ok: false, error: 'Could not reach the tab.' },
    })
    await failed.flush()
    failed.elements['#handles']?.dispatch(
      'click',
      actionFor(failed, 1, 'scroll'),
    )
    await failed.flush()

    expect(failed.window.closeCalls).toBe(0)
    expect(failed.elements['#status']?.textContent).toContain(
      'Could not reach the tab.',
    )
  })

  it('does not write configuration when removal is cancelled', async () => {
    const harness = createHarness({}, false)
    await harness.flush()
    const remove = actionFor(harness, 0, 'remove')

    expect(remove.textContent).toBe('🗑')
    expect(remove.attributes['aria-label']).toBe('Stop following @example_user')
    harness.elements['#handles']?.dispatch('click', remove)
    await harness.flush()

    expect(harness.confirmations[0]).toContain(
      'Saved posts and images will be retained.',
    )
    expect(harness.messages).not.toContainEqual(
      expect.objectContaining({ type: 'config:put' }),
    )
  })

  it('removes only the confirmed handle while retaining saved-content messaging', async () => {
    const harness = createHarness()
    await harness.flush()
    harness.elements['#handles']?.dispatch(
      'click',
      actionFor(harness, 1, 'remove'),
    )
    await harness.flush()

    expect(harness.messages).toContainEqual({
      type: 'config:put',
      config: { followedHandles: ['example_user'] },
    })
    expect(harness.elements['#status']?.textContent).toContain(
      'Saved posts were retained.',
    )
  })

  it('shows the active scrolling run and sends a stop action', async () => {
    const harness = createHarness({
      'scroll:status': {
        ok: true,
        data: {
          run: {
            id: 'run-1',
            tabId: 42,
            handle: 'example_user',
            endsAt: '2026-10-11T12:05:00.000Z',
            phase: 'scrolling',
          },
        },
      },
    })
    await harness.flush()

    expect(harness.elements['#scroll-status']?.textContent).toContain(
      'Scrolling @example_user',
    )
    expect(harness.elements['#scroll-status']?.textContent).toContain(
      'five minutes',
    )
    expect(harness.elements['#stop-scroll']?.hidden).toBe(false)

    harness.elements['#stop-scroll']?.dispatch('click')
    await harness.flush()

    expect(harness.messages).toContainEqual({ type: 'scroll:stop' })
    expect(harness.elements['#stop-scroll']?.hidden).toBe(true)
    expect(harness.elements['#status']?.textContent).toBe('Scrolling stopped.')
  })

  it('reports profile-open and scrolling-status errors without closing', async () => {
    const harness = createHarness({
      'profile:open': { ok: false, error: 'No active browser tab.' },
      'scroll:status': { ok: false, error: 'Status unavailable.' },
    })
    await harness.flush()

    expect(harness.elements['#scroll-status']?.textContent).toContain(
      'Status unavailable.',
    )
    expect(harness.elements['#stop-scroll']?.hidden).toBe(true)

    harness.elements['#handles']?.dispatch(
      'click',
      actionFor(harness, 0, 'open'),
    )
    await harness.flush()

    expect(harness.elements['#status']?.textContent).toContain(
      'No active browser tab.',
    )
    expect(harness.window.closeCalls).toBe(0)
  })
})

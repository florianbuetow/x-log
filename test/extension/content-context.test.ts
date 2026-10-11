import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

interface ContentHarness {
  readonly loadConfig: () => Promise<void>
  readonly scanPage: () => Promise<void>
}

describe('content script after an extension reload', () => {
  it.each([
    ['loadConfig', 'sendMessage'],
    ['loadConfig', 'lastError'],
    ['scanPage', 'sendMessage'],
    ['scanPage', 'lastError'],
  ] as const)(
    'stops capture when %s sees invalidated %s',
    async (callSite, failurePoint) => {
      const source = readFileSync('extension/content.js', 'utf8')
      const timers = new Map<number, () => void>()
      let nextTimer = 1
      let invalidated = false
      let disconnects = 0
      const runtime = {
        onMessage: { addListener: () => undefined },
        sendMessage: (_message: unknown, respond: (value: unknown) => void) => {
          if (invalidated && failurePoint === 'sendMessage') {
            throw new Error('Extension context invalidated.')
          }
          respond({ ok: true, data: { followedHandles: ['example_user'] } })
        },
        get lastError() {
          if (invalidated && failurePoint === 'lastError') {
            throw new Error('Extension context invalidated.')
          }
          return undefined
        },
      }
      const time = {
        closest: () => ({ href: 'https://x.com/example_user/status/123' }),
        getAttribute: () => '2026-10-11T12:00:00.000Z',
      }
      const tweet = {
        querySelectorAll: () => [time],
        querySelector: () => ({ innerText: 'A visible post' }),
        getBoundingClientRect: () => ({
          width: 500,
          height: 100,
          top: 0,
          bottom: 100,
        }),
      }
      const context = {
        chrome: { runtime },
        document: {
          documentElement: {},
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          querySelectorAll: () => [tweet],
        },
        window: {
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          innerHeight: 900,
        },
        getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
        location: {
          href: 'https://x.com/example_user',
          pathname: '/example_user',
          origin: 'https://x.com',
        },
        MutationObserver: class {
          observe(): void {}
          disconnect(): void {
            disconnects += 1
          }
        },
        setTimeout: (callback: () => void) => {
          const id = nextTimer++
          timers.set(id, callback)
          return id
        },
        clearTimeout: (id: number) => {
          timers.delete(id)
        },
        console: { warn: () => undefined },
        performance: { timeOrigin: 1_000_000 },
        URL,
      }
      const harness = runInNewContext(
        `${source}\n;({ loadConfig, scanPage })`,
        context,
      ) as ContentHarness
      await Promise.resolve()
      expect(timers.size).toBeGreaterThan(0)

      invalidated = true
      await expect(harness[callSite]()).resolves.toBeUndefined()
      expect(disconnects).toBe(1)
      expect(timers.size).toBe(0)
    },
  )
})

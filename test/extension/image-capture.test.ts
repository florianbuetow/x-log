import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

interface ImageDescriptor {
  readonly url: string
  readonly mediaId: string
  readonly position: number
}

interface CapturedPost {
  readonly id: string
  readonly author: string
  readonly threadRootId: string | null
  readonly images?: readonly ImageDescriptor[]
}

interface ContentHarness {
  readonly applyConfig: (config: { followedHandles: readonly string[] }) => void
  readonly captureProfilePosts: () => readonly CapturedPost[] | null
  readonly captureThreadPosts: () => readonly CapturedPost[] | null
}

interface FakeLocation {
  href: string
  pathname: string
  origin: string
}

function media(mediaId: string): { currentSrc: string; src: string } {
  const url = `https://pbs.twimg.com/media/${mediaId}?format=jpg&name=small`
  return { currentSrc: url, src: url }
}

function photo(
  href: string,
  ...images: readonly { currentSrc: string; src: string }[]
): {
  href: string
  querySelectorAll: (selector: string) => readonly unknown[]
} {
  return {
    href,
    querySelectorAll: (selector) => (selector === 'img' ? images : []),
  }
}

function tweet(
  author: string,
  id: string,
  anchors: readonly ReturnType<typeof photo>[],
): object {
  const time = {
    closest: () => ({ href: `https://x.com/${author}/status/${id}` }),
    getAttribute: () => '2026-10-11T12:00:00.000Z',
  }
  return {
    querySelectorAll: (selector: string) => {
      if (selector === 'time[datetime]') return [time]
      if (selector === 'a[href*="/photo/"]') return anchors
      return []
    },
    querySelector: () => ({ innerText: `Post ${id}` }),
    getBoundingClientRect: () => ({
      width: 500,
      height: 100,
      top: 0,
      bottom: 100,
    }),
  }
}

function createHarness(
  location: FakeLocation,
  tweets: readonly object[],
): ContentHarness {
  const source = readFileSync('extension/content.js', 'utf8')
  const context = {
    chrome: {
      runtime: {
        onMessage: { addListener: () => undefined },
        sendMessage: (_message: unknown, respond: (value: unknown) => void) =>
          respond({ ok: true, data: { followedHandles: ['example_user'] } }),
        lastError: undefined,
      },
    },
    document: {
      documentElement: {},
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      querySelectorAll: () => tweets,
    },
    window: {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      innerHeight: 900,
    },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    location,
    MutationObserver: class {
      observe(): void {}
      disconnect(): void {}
    },
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    console: { warn: () => undefined },
    performance: { timeOrigin: 1_000_000 },
    URL,
  }
  return runInNewContext(
    `${source}\n;({ applyConfig, captureProfilePosts, captureThreadPosts })`,
    context,
  ) as ContentHarness
}

describe('rendered X image capture', () => {
  it('captures unique safe media from each authored post on the main profile view', () => {
    const anchors = Array.from({ length: 12 }, (_, index) =>
      photo(
        `https://x.com/example_user/status/100/photo/${index + 1}`,
        media(`own_${index + 1}`),
      ),
    )
    anchors.splice(
      1,
      0,
      photo('https://x.com/example_user/status/100/photo/1', media('own_1')),
    )
    const location = {
      href: 'https://x.com/example_user',
      pathname: '/example_user',
      origin: 'https://x.com',
    }
    const harness = createHarness(location, [
      tweet('example_user', '100', anchors),
    ])
    harness.applyConfig({ followedHandles: ['example_user'] })

    const posts = harness.captureProfilePosts()

    expect(posts).toHaveLength(1)
    expect(posts?.[0]?.images).toHaveLength(10)
    expect(posts?.[0]?.images?.[0]).toEqual({
      url: 'https://pbs.twimg.com/media/own_1?format=jpg&name=small',
      mediaId: 'own_1',
      position: 1,
    })

    location.href = 'https://x.com/example_user/with_replies'
    location.pathname = '/example_user/with_replies'
    expect(harness.captureProfilePosts()?.[0]).not.toHaveProperty('images')

    location.href = 'https://x.com/example_user/media'
    location.pathname = '/example_user/media'
    expect(harness.captureProfilePosts()?.[0]).not.toHaveProperty('images')
  })

  it('ignores photo ordinals outside the supported range', () => {
    const location = {
      href: 'https://x.com/example_user',
      pathname: '/example_user',
      origin: 'https://x.com',
    }
    const harness = createHarness(location, [
      tweet('example_user', '100', [
        photo('https://x.com/example_user/status/100/photo/0', media('zero')),
        photo(
          'https://x.com/example_user/status/100/photo/11',
          media('eleven'),
        ),
        photo('https://x.com/example_user/status/100/photo/1', media('one')),
      ]),
    ])
    harness.applyConfig({ followedHandles: ['example_user'] })
    expect(harness.captureProfilePosts()?.[0]?.images).toEqual([
      {
        url: 'https://pbs.twimg.com/media/one?format=jpg&name=small',
        mediaId: 'one',
        position: 1,
      },
    ])
  })

  it('captures only the thread root own photos, excluding quotes, replies, videos, and unsafe sources', () => {
    const root = tweet('example_user', '100', [
      photo(
        'https://x.com/example_user/status/100/photo/1',
        media('root_image'),
      ),
      photo('https://x.com/quoted/status/200/photo/1', media('quote_image')),
      photo(
        'https://x.com/example_user/status/100/video/1',
        media('video_poster'),
      ),
      photo('https://x.com/example_user/status/100/photo/2', {
        currentSrc: 'https://pbs.twimg.com/profile_images/avatar.jpg',
        src: 'https://pbs.twimg.com/profile_images/avatar.jpg',
      }),
      photo(
        'https://x.com/example_user/status/100/photo/3/',
        media('non_exact_path'),
      ),
    ])
    const reply = tweet('replyauthor', '101', [
      photo(
        'https://x.com/replyauthor/status/101/photo/1',
        media('reply_image'),
      ),
    ])
    const location = {
      href: 'https://x.com/example_user/status/100',
      pathname: '/example_user/status/100',
      origin: 'https://x.com',
    }
    const harness = createHarness(location, [root, reply])
    harness.applyConfig({ followedHandles: ['example_user'] })

    const posts = harness.captureThreadPosts()

    expect(posts).toHaveLength(2)
    expect(posts?.[0]?.images).toEqual([
      {
        url: 'https://pbs.twimg.com/media/root_image?format=jpg&name=small',
        mediaId: 'root_image',
        position: 1,
      },
    ])
    expect(posts?.[1]).not.toHaveProperty('images')
  })
})

const X_SELECTORS = Object.freeze({
  tweet: 'article[data-testid="tweet"]',
  tweetText: '[data-testid="tweetText"]',
  statusLink: 'a[href*="/status/"]',
  time: 'time[datetime]',
})

const STATUS_PATH = /^\/([^/]+)\/status\/(\d+)/i
const PROFILE_PATH = /^\/([^/]+)(?:\/(?:with_replies|media))?\/?$/i
const RESERVED_PATHS = new Set([
  'compose',
  'explore',
  'home',
  'i',
  'messages',
  'notifications',
  'search',
  'settings',
])
const SCAN_DELAY_MS = 750
const CAPTURE_RETRY_MS = 5_000
const MAX_THREAD_REPLIES = 20
const MAX_POST_IMAGES = 10
const MAX_SCROLL_DURATION_MS = 5 * 60 * 1_000
const MIN_SCROLL_DELAY_MS = 1_500
const MAX_SCROLL_DELAY_MS = 4_000
const LONG_SCROLL_PAUSE_CHANCE = 0.08
const MIN_SCROLL_FACTOR = 0.35
const MAX_SCROLL_FACTOR = 0.8
const PHOTO_PATH = /^\/([^/]+)\/status\/(\d+)\/photo\/([1-9]\d*)$/i
const MEDIA_PATH = /^\/media\/([A-Za-z0-9_-]+)$/

let followedHandles = new Set()
let scanTimer
let lastLocation = location.href
let lastCaptureAttemptAt = 0
let lastPayloadSignature = ''
let currentThreadKey = ''
let threadReplies = new Map()
let configRetryTimer
let captureRetryTimer
let lastImageFailureSignature = ''
let stopped = false
let scrollReadySent = false
let activeScroll = null
let scanQueue = Promise.resolve()
let scrollStartBlockReason = null

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (stopped) return
  if (message?.type === 'config:changed') {
    applyConfig(message.config)
    scheduleScan()
    return
  }
  if (message?.type === 'scroll:cancel' && activeScroll?.id === message.id) {
    stopScrolling('cancelled')
    sendResponse?.({ ok: true })
  }
})

const observer = new MutationObserver(() => scheduleScan())
observer.observe(document.documentElement, { childList: true, subtree: true })
window.addEventListener('popstate', handleLocationChange)
window.addEventListener('hashchange', handleLocationChange)
window.addEventListener('scroll', scheduleScan, { passive: true })
document.addEventListener('scroll', scheduleScan, {
  capture: true,
  passive: true,
})
document.addEventListener('pointerdown', handlePointerStop, true)
document.addEventListener('mousedown', handlePointerStop, true)
document.addEventListener('keydown', handleEscapeStop, true)
document.addEventListener('visibilitychange', handleVisibilityStop)
window.addEventListener('blur', handleBlurStop)
window.addEventListener('pagehide', handlePageHideStop)

void loadConfig()

async function loadConfig() {
  if (stopped) return
  const response = await sendMessage({ type: 'config:get' })
  if (!response.ok) {
    if (response.contextInvalidated) {
      stopCapture()
      return
    }
    console.warn('XLog Capture could not load its config:', response.error)
    configRetryTimer = setTimeout(() => void loadConfig(), 30_000)
    return
  }

  applyConfig(response.data)
  scheduleScan()
  await announceScrollReady()
}

function applyConfig(config) {
  followedHandles = new Set(
    config.followedHandles
      .map((handle) => normalizeHandle(handle))
      .filter(Boolean),
  )
  if (activeScroll && !followedHandles.has(activeScroll.handle)) {
    stopScrolling('unfollowed')
  }
}

function scheduleScan() {
  if (stopped) return
  handleLocationChange()
  clearTimeout(scanTimer)
  scanTimer = setTimeout(() => void scanPage(), SCAN_DELAY_MS)
}

function handleLocationChange() {
  if (location.href === lastLocation) {
    return
  }

  lastLocation = location.href
  if (activeScroll && location.pathname !== activeScroll.expectedPath) {
    stopScrolling('navigation')
  }
  lastPayloadSignature = ''
  currentThreadKey = ''
  threadReplies = new Map()
}

async function scanPage() {
  const requestedByScroll = activeScroll !== null
  const result = scanQueue.then(() => performScanPage())
  scanQueue = result.then(
    () => undefined,
    () => undefined,
  )

  try {
    const succeeded = await result
    if (!succeeded && activeScroll) {
      stopScrolling('capture-failed')
    }
    if (succeeded) return true
    return requestedByScroll ? false : undefined
  } catch (error) {
    console.warn('XLog Capture could not inspect rendered posts:', error)
    if (activeScroll) stopScrolling('capture-failed')
    return requestedByScroll ? false : undefined
  }
}

async function performScanPage() {
  if (stopped || followedHandles.size === 0) {
    return !stopped
  }

  const posts = captureProfilePosts() ?? captureThreadPosts()
  if (!posts || posts.length === 0) {
    return true
  }

  const signature = posts
    .map(
      (post) =>
        `${post.id}:${post.threadRootId ?? 'root'}:${(post.images ?? [])
          .map((image) => `${image.mediaId}:${image.position}`)
          .join('|')}`,
    )
    .join(',')
  const now = Date.now()
  if (
    signature === lastPayloadSignature &&
    now - lastCaptureAttemptAt < CAPTURE_RETRY_MS
  ) {
    return true
  }

  lastPayloadSignature = signature
  lastCaptureAttemptAt = now
  const response = await sendMessage({
    type: 'captures:post',
    capture: { posts, observedAt: new Date().toISOString() },
  })

  if (!response.ok) {
    if (response.contextInvalidated) {
      stopCapture()
      return false
    }
    console.warn('XLog Capture could not save rendered posts:', response.error)
    captureRetryTimer = setTimeout(scheduleScan, CAPTURE_RETRY_MS)
    return false
  }

  if (
    Number.isSafeInteger(response.data?.imagesFailed) &&
    response.data.imagesFailed > 0 &&
    lastImageFailureSignature !== signature
  ) {
    lastImageFailureSignature = signature
    console.warn(
      `XLog Capture could not save ${response.data.imagesFailed} rendered ${response.data.imagesFailed === 1 ? 'image' : 'images'}.`,
    )
  } else if (response.data?.imagesFailed === 0) {
    lastImageFailureSignature = ''
  }
  return true
}

function stopCapture() {
  if (stopped) return
  stopScrolling('extension-invalidated')
  stopped = true
  observer.disconnect()
  clearTimeout(scanTimer)
  clearTimeout(configRetryTimer)
  clearTimeout(captureRetryTimer)
  window.removeEventListener('popstate', handleLocationChange)
  window.removeEventListener('hashchange', handleLocationChange)
  window.removeEventListener('scroll', scheduleScan)
  document.removeEventListener('scroll', scheduleScan, true)
  document.removeEventListener('pointerdown', handlePointerStop, true)
  document.removeEventListener('mousedown', handlePointerStop, true)
  document.removeEventListener('keydown', handleEscapeStop, true)
  document.removeEventListener('visibilitychange', handleVisibilityStop)
  window.removeEventListener('blur', handleBlurStop)
  window.removeEventListener('pagehide', handlePageHideStop)
}

async function announceScrollReady() {
  if (stopped || scrollReadySent) return
  scrollReadySent = true

  const response = await sendMessage({
    type: 'scroll:ready',
    documentStartedAt: performance.timeOrigin,
  })
  if (!response.ok) {
    if (response.contextInvalidated) stopCapture()
    return
  }

  const candidate = response.data?.run
  const run = parseScrollRun(candidate)
  if (run && scrollStartBlockReason) {
    void sendMessage({
      type: 'scroll:ended',
      id: run.id,
      reason: scrollStartBlockReason,
    })
  } else if (run) {
    startScrolling(run)
  } else if (typeof candidate?.id === 'string' && candidate.id.length > 0) {
    void sendMessage({
      type: 'scroll:ended',
      id: candidate.id,
      reason: 'ineligible',
    })
  }
}

function parseScrollRun(candidate) {
  if (
    !candidate ||
    typeof candidate.id !== 'string' ||
    candidate.id.length === 0 ||
    !Number.isSafeInteger(candidate.tabId) ||
    candidate.tabId < 0 ||
    typeof candidate.handle !== 'string' ||
    !Number.isFinite(candidate.endsAt)
  ) {
    return null
  }

  const handle = normalizeHandle(candidate.handle)
  const profileHandle = exactProfileHandle()
  const now = Date.now()
  if (
    document.visibilityState !== 'visible' ||
    profileHandle !== handle ||
    !followedHandles.has(handle) ||
    candidate.endsAt <= now
  ) {
    return null
  }

  return {
    id: candidate.id,
    tabId: candidate.tabId,
    handle,
    endsAt: Math.min(candidate.endsAt, now + MAX_SCROLL_DURATION_MS),
    expectedPath: location.pathname,
    deadlineTimer: undefined,
    waitTimer: undefined,
    waitResolve: undefined,
    control: undefined,
  }
}

function exactProfileHandle() {
  const match = location.pathname.match(/^\/([^/]+)\/?$/i)
  if (!match) return null
  const handle = normalizeHandle(match[1])
  return handle && !RESERVED_PATHS.has(handle) ? handle : null
}

function startScrolling(run) {
  if (stopped || activeScroll) return
  activeScroll = run
  installScrollStopControls(run)
  run.deadlineTimer = setTimeout(
    () => stopScrolling('deadline'),
    Math.max(0, run.endsAt - Date.now()),
  )
  void scrollUntilStopped(run)
}

async function scrollUntilStopped(run) {
  while (isActiveScroll(run)) {
    if (!scrollContextIsValid(run)) return

    const captured = await scanPage()
    if (!isActiveScroll(run)) return
    if (!captured) {
      stopScrolling('capture-failed')
      return
    }
    if (!scrollContextIsValid(run)) return

    const viewport = Math.max(1, window.innerHeight)
    const factor =
      MIN_SCROLL_FACTOR +
      Math.random() * (MAX_SCROLL_FACTOR - MIN_SCROLL_FACTOR)
    const distance = Math.min(
      viewport,
      Math.max(1, Math.round(viewport * factor)),
    )
    window.scrollBy({ top: distance, left: 0, behavior: 'smooth' })

    let delay =
      MIN_SCROLL_DELAY_MS +
      Math.random() * (MAX_SCROLL_DELAY_MS - MIN_SCROLL_DELAY_MS)
    if (Math.random() < LONG_SCROLL_PAUSE_CHANCE) {
      delay += 2_000 + Math.random() * 4_000
    }
    await waitForNextScroll(run, Math.min(delay, run.endsAt - Date.now()))
  }
}

function scrollContextIsValid(run) {
  if (!isActiveScroll(run)) return false
  if (Date.now() >= run.endsAt) {
    stopScrolling('deadline')
    return false
  }
  if (
    document.visibilityState !== 'visible' ||
    location.pathname !== run.expectedPath ||
    exactProfileHandle() !== run.handle
  ) {
    stopScrolling(
      document.visibilityState === 'visible' ? 'navigation' : 'hidden',
    )
    return false
  }
  return true
}

function waitForNextScroll(run, delay) {
  if (delay <= 0) {
    stopScrolling('deadline')
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    run.waitResolve = resolve
    run.waitTimer = setTimeout(() => {
      run.waitTimer = undefined
      run.waitResolve = undefined
      resolve()
    }, delay)
  })
}

function installScrollStopControls(run) {
  const control = document.createElement('button')
  control.type = 'button'
  control.textContent = 'Stop XLog scrolling'
  control.setAttribute('aria-label', 'Stop XLog automatic scrolling')
  Object.assign(control.style, {
    position: 'fixed',
    right: '16px',
    bottom: '16px',
    zIndex: '2147483647',
    padding: '10px 14px',
    border: '1px solid #536471',
    borderRadius: '9999px',
    background: '#0f1419',
    color: '#ffffff',
    font: '600 14px system-ui, sans-serif',
    cursor: 'pointer',
  })
  document.body?.append(control)
  control.addEventListener('click', () => stopScrolling('control'))
  run.control = control
}

function handlePointerStop() {
  scrollStartBlockReason = 'pointer'
  stopScrolling('pointer')
}

function handleEscapeStop(event) {
  if (event.key !== 'Escape') return
  scrollStartBlockReason = 'escape'
  stopScrolling('escape')
}

function handleBlurStop() {
  scrollStartBlockReason = 'blur'
  stopScrolling('blur')
}

function handleVisibilityStop() {
  if (document.visibilityState === 'visible') return
  scrollStartBlockReason = 'hidden'
  stopScrolling('hidden')
}

function handlePageHideStop() {
  scrollStartBlockReason = 'pagehide'
  stopScrolling('pagehide')
}

function stopScrolling(reason) {
  const run = activeScroll
  if (!run) return
  activeScroll = null
  clearTimeout(run.deadlineTimer)
  clearTimeout(run.waitTimer)
  run.waitResolve?.()
  window.scrollTo({
    top: window.scrollY,
    left: window.scrollX,
    behavior: 'instant',
  })
  run.control?.remove()
  void sendMessage({ type: 'scroll:ended', id: run.id, reason })
}

function isActiveScroll(run) {
  return !stopped && activeScroll === run
}

function captureProfilePosts() {
  const match = location.pathname.match(PROFILE_PATH)
  if (!match) {
    return null
  }

  const profileHandle = normalizeHandle(match[1])
  if (
    RESERVED_PATHS.has(profileHandle) ||
    !followedHandles.has(profileHandle)
  ) {
    return null
  }

  const includeImages =
    location.pathname === `/${match[1]}` ||
    location.pathname === `/${match[1]}/`
  return visibleTweets()
    .map((tweet) => extractPost(tweet, null, includeImages))
    .filter((post) => post !== null && post.author === profileHandle)
}

function captureThreadPosts() {
  const match = location.pathname.match(STATUS_PATH)
  if (!match) {
    return null
  }

  const rootAuthor = normalizeHandle(match[1])
  const rootId = match[2]
  if (!followedHandles.has(rootAuthor) || !rootId) {
    return null
  }

  const threadKey = `${rootAuthor}:${rootId}`
  if (currentThreadKey !== threadKey) {
    currentThreadKey = threadKey
    threadReplies = new Map()
  }

  const extracted = visibleTweets()
    .map((tweet) => ({ post: extractPost(tweet, rootId, false), tweet }))
    .filter((item) => item.post !== null)
  const root = extracted.find(
    ({ post }) => post.id === rootId && post.author === rootAuthor,
  )
  for (const { post } of extracted) {
    if (post.id === rootId || threadReplies.has(post.id)) {
      continue
    }

    if (threadReplies.size >= MAX_THREAD_REPLIES) {
      break
    }

    threadReplies.set(post.id, post)
  }

  const replies = [...threadReplies.values()]
  return root
    ? [
        {
          ...root.post,
          threadRootId: null,
          images: extractImages(root.tweet, root.post),
        },
        ...replies,
      ]
    : replies
}

function visibleTweets() {
  return [...document.querySelectorAll(X_SELECTORS.tweet)].filter(isVisible)
}

function extractPost(tweet, threadRootId, includeImages) {
  const status = findStatus(tweet)
  if (!status) {
    return null
  }

  const text =
    tweet.querySelector(X_SELECTORS.tweetText)?.innerText?.trim() ?? ''
  const post = {
    id: status.id,
    author: status.author,
    text,
    url: `https://x.com/${status.author}/status/${status.id}`,
    postedAt: status.postedAt,
    threadRootId,
  }
  return includeImages ? { ...post, images: extractImages(tweet, post) } : post
}

function extractImages(tweet, post) {
  const images = []
  const mediaIds = new Set()
  const positions = new Set()

  for (const anchor of tweet.querySelectorAll('a[href*="/photo/"]')) {
    if (images.length >= MAX_POST_IMAGES) break

    const link = parseUrl(anchor.href)
    const match = link?.pathname.match(PHOTO_PATH)
    const position = Number(match?.[3])
    if (
      !match ||
      normalizeHandle(match[1]) !== post.author ||
      match[2] !== post.id ||
      !Number.isSafeInteger(position) ||
      position < 1 ||
      position > MAX_POST_IMAGES ||
      positions.has(position)
    ) {
      continue
    }

    for (const image of anchor.querySelectorAll('img')) {
      const source = parseUrl(image.currentSrc || image.src)
      const mediaMatch = source?.pathname.match(MEDIA_PATH)
      if (
        source?.origin !== 'https://pbs.twimg.com' ||
        source.username !== '' ||
        source.password !== '' ||
        !mediaMatch ||
        mediaIds.has(mediaMatch[1])
      ) {
        continue
      }

      images.push({
        url: source.href,
        mediaId: mediaMatch[1],
        position,
      })
      mediaIds.add(mediaMatch[1])
      positions.add(position)
      break
    }
  }

  return images
}

function parseUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    return new URL(value, location.origin)
  } catch {
    return null
  }
}

function findStatus(tweet) {
  for (const time of tweet.querySelectorAll(X_SELECTORS.time)) {
    const link = time.closest(X_SELECTORS.statusLink)
    if (!link) continue
    const url = new URL(link.href, location.origin)
    const match = url.pathname.match(STATUS_PATH)
    if (
      match?.[1] &&
      match[2] &&
      url.pathname === `/${match[1]}/status/${match[2]}`
    ) {
      return {
        author: normalizeHandle(match[1]),
        id: match[2],
        postedAt: time.getAttribute('datetime'),
      }
    }
  }

  return null
}

function isVisible(element) {
  const rect = element.getBoundingClientRect()
  const style = getComputedStyle(element)
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.top < window.innerHeight &&
    style.display !== 'none' &&
    style.visibility !== 'hidden'
  )
}

function normalizeHandle(handle) {
  return typeof handle === 'string'
    ? handle.trim().replace(/^@/, '').toLowerCase()
    : ''
}

function sendMessage(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        try {
          const error = chrome.runtime.lastError
          if (error) {
            resolve(messageFailure(error.message))
            return
          }
          resolve(
            response ?? {
              ok: false,
              error: 'The extension background service did not respond.',
            },
          )
        } catch (error) {
          resolve(messageFailure(error))
        }
      })
    } catch (error) {
      resolve(messageFailure(error))
    }
  })
}

function messageFailure(error) {
  const message = error instanceof Error ? error.message : String(error)
  return {
    ok: false,
    error: message,
    contextInvalidated: message.includes('Extension context invalidated'),
  }
}

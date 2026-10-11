const BACKEND_ORIGIN = 'http://127.0.0.1:4318'
const CONFIG_CACHE_KEY = 'backendConfig'
const BADGE_COLOR = '#1d9bf0'
const BADGE_ERROR_COLOR = '#d43838'
const SCROLL_RUN_KEY = 'scrollRun'
const SCROLL_DURATION_MS = 5 * 60 * 1000
let scrollOperations = Promise.resolve()

chrome.tabs.onRemoved.addListener((tabId) => {
  void queueScroll(async () => {
    const run = await readScrollRun()
    if (run?.tabId === tabId) await clearScrollRun(run)
  }).catch(reportScrollError)
})

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void queueScroll(async () => {
    const run = await readScrollRun()
    if (run && run.tabId !== tabId) await clearScrollRun(run)
  }).catch(reportScrollError)
})

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url === undefined && change.status !== 'loading') return
  void queueScroll(async () => {
    const run = await readScrollRun()
    if (!run || run.tabId !== tabId) return
    if (
      (change.url !== undefined && !isProfileUrl(change.url, run.handle)) ||
      (change.status === 'loading' && run.phase === 'running')
    )
      await clearScrollRun(run)
  }).catch(reportScrollError)
})

chrome.runtime.onInstalled.addListener(() => {
  void refreshStatusBadge()
})

chrome.runtime.onStartup.addListener(() => {
  void refreshStatusBadge()
})

void refreshStatusBadge()

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }))

  return true
})

async function handleMessage(message, sender) {
  if (!message || typeof message.type !== 'string') {
    throw new Error('Invalid extension message.')
  }

  switch (message.type) {
    case 'config:get':
      return getConfig()
    case 'config:put':
      return putConfig(message.config)
    case 'captures:post':
      return postCaptures(message.capture)
    case 'status:get':
      return getStatus()
    case 'events:get':
      return getEvents()
    case 'profile:open':
    case 'scroll:start':
      requirePopup(sender)
      return queueScroll(() =>
        openProfile(message.handle, message.type === 'scroll:start'),
      )
    case 'scroll:status':
      requirePopup(sender)
      return queueScroll(async () => ({ run: await readScrollRun() }))
    case 'scroll:stop':
      requirePopup(sender)
      return queueScroll(async () => {
        const run = await readScrollRun()
        if (run) await clearScrollRun(run)
        return { run: null }
      })
    case 'scroll:ready':
      return queueScroll(() =>
        claimScrollRun(sender, message.documentStartedAt),
      )
    case 'scroll:ended':
      return queueScroll(async () => {
        const run = await readScrollRun()
        if (
          run?.id === message.id &&
          sender?.tab?.id === run.tabId &&
          sender.frameId === 0
        ) {
          await chrome.storage.session.remove(SCROLL_RUN_KEY)
        }
        return { ok: true }
      })
    default:
      throw new Error(`Unknown extension message: ${message.type}`)
  }
}

function requirePopup(sender) {
  if (
    sender?.url !== chrome.runtime.getURL('popup.html') ||
    sender.tab !== undefined
  ) {
    throw new Error(
      'Open the XLog popup to control scrolling or profile navigation.',
    )
  }
}

function queueScroll(operation) {
  const result = scrollOperations.then(operation)
  scrollOperations = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

function reportScrollError(error) {
  console.warn('XLog scrolling:', errorMessage(error))
}

function isProfileUrl(value, handle) {
  try {
    const url = new URL(value)
    return (
      (url.origin === 'https://x.com' || url.origin === 'https://www.x.com') &&
      url.pathname.replace(/\/$/, '').toLowerCase() === `/${handle}`
    )
  } catch {
    return false
  }
}

async function readScrollRun() {
  const stored = await chrome.storage.session.get(SCROLL_RUN_KEY)
  const run = stored[SCROLL_RUN_KEY]
  if (!run) return null
  if (run.endsAt <= Date.now()) {
    await clearScrollRun(run)
    return null
  }
  return run
}

async function clearScrollRun(run) {
  await chrome.storage.session.remove(SCROLL_RUN_KEY)
  try {
    await chrome.tabs.sendMessage(run.tabId, {
      type: 'scroll:cancel',
      id: run.id,
    })
  } catch {
    // A closed or navigated tab no longer has a receiver to cancel.
  }
}

async function openProfile(handle, scrolling) {
  if (typeof handle !== 'string' || !/^[a-z0-9_]{1,15}$/.test(handle)) {
    throw new Error('Invalid followed profile handle.')
  }
  if (scrolling) {
    const config = await requestJson('/api/config', {
      signal: AbortSignal.timeout(5000),
    })
    assertConfig(config)
    if (!config.followedHandles.includes(handle)) {
      throw new Error(`Follow @${handle} before starting scrolling.`)
    }
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!Number.isSafeInteger(tab?.id))
    throw new Error('No current tab is available.')
  const previous = await readScrollRun()
  if (previous) await clearScrollRun(previous)
  const run = scrolling
    ? {
        id: crypto.randomUUID(),
        tabId: tab.id,
        handle,
        startedAt: Date.now(),
        endsAt: Date.now() + SCROLL_DURATION_MS,
        phase: 'loading',
      }
    : null
  if (run) await chrome.storage.session.set({ [SCROLL_RUN_KEY]: run })
  try {
    await chrome.tabs.update(tab.id, { url: `https://x.com/${handle}` })
  } catch (error) {
    if (run) await clearScrollRun(run)
    throw error
  }
  return { run }
}

async function claimScrollRun(sender, documentStartedAt) {
  const run = await readScrollRun()
  if (
    !run ||
    run.phase !== 'loading' ||
    !Number.isFinite(documentStartedAt) ||
    documentStartedAt < run.startedAt ||
    sender?.tab?.id !== run.tabId ||
    sender.frameId !== 0 ||
    !isProfileUrl(sender.url, run.handle)
  )
    return { run: null }
  const active = { ...run, phase: 'running' }
  await chrome.storage.session.set({ [SCROLL_RUN_KEY]: active })
  return { run: active }
}

async function getConfig() {
  const badgeRefresh = refreshStatusBadge()

  try {
    const config = await requestJson('/api/config')
    assertConfig(config)
    await chrome.storage.local.set({ [CONFIG_CACHE_KEY]: config })
    await badgeRefresh
    return config
  } catch (error) {
    await badgeRefresh
    const cached = await chrome.storage.local.get(CONFIG_CACHE_KEY)
    const config = cached[CONFIG_CACHE_KEY]

    if (isConfig(config)) {
      return { ...config, stale: true, error: errorMessage(error) }
    }

    throw error
  }
}

async function putConfig(config) {
  assertConfig(config)
  const saved = await requestJson('/api/config', {
    method: 'PUT',
    body: JSON.stringify(config),
  })
  assertConfig(saved)
  await chrome.storage.local.set({ [CONFIG_CACHE_KEY]: saved })
  await notifyConfigChanged(saved)
  await refreshStatusBadge()
  return saved
}

async function postCaptures(capture) {
  assertCapture(capture)
  const result = await requestJson('/api/captures', {
    method: 'POST',
    body: JSON.stringify(capture),
  })
  await refreshStatusBadge()
  return result
}

async function getStatus() {
  try {
    const status = await requestJson('/api/status')
    assertStatus(status)
    await setSavedCountBadge(status.postCount)
    return status
  } catch (error) {
    await setBadgeError()
    throw error
  }
}

async function getEvents() {
  try {
    const result = await requestJson('/api/events?limit=100')
    assertEventsResult(result)
    await setSavedCountBadge(result.totalPosts)
    return result
  } catch (error) {
    await setBadgeError()
    throw error
  }
}

async function refreshStatusBadge() {
  try {
    await getStatus()
  } catch {
    // getStatus already leaves the badge in an explicit error state.
  }
}

async function setSavedCountBadge(postCount) {
  await Promise.all([
    chrome.action.setBadgeText({ text: formatBadgeCount(postCount) }),
    chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR }),
    chrome.action.setTitle({
      title: `XLog Capture — ${formatPostCount(postCount)} saved`,
    }),
  ])
}

async function setBadgeError() {
  await Promise.all([
    chrome.action.setBadgeText({ text: '!' }),
    chrome.action.setBadgeBackgroundColor({ color: BADGE_ERROR_COLOR }),
    chrome.action.setTitle({
      title: 'XLog Capture — backend server not reachable',
    }),
  ])
}

function formatBadgeCount(postCount) {
  return postCount > 999 ? '999+' : String(postCount)
}

function formatPostCount(postCount) {
  return `${postCount} ${postCount === 1 ? 'post' : 'posts'}`
}

async function requestJson(path, options = {}) {
  let response

  try {
    response = await fetch(`${BACKEND_ORIGIN}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-XLog-Client': 'extension',
        ...options.headers,
      },
    })
  } catch (error) {
    await setBadgeError()
    throw new Error(
      `Backend server is not running (cannot reach ${BACKEND_ORIGIN}). Start it with "just start".`,
      { cause: error },
    )
  }

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(
      `Local XLog service returned ${response.status}${detail ? `: ${detail}` : '.'}`,
    )
  }

  const text = await response.text()
  if (!text) {
    return {}
  }

  try {
    return JSON.parse(text)
  } catch {
    throw new Error('Local XLog service returned invalid JSON.')
  }
}

async function notifyConfigChanged(config) {
  const tabs = await chrome.tabs.query({
    url: ['https://x.com/*', 'https://www.x.com/*'],
  })
  await Promise.allSettled(
    tabs.map((tab) =>
      tab.id === undefined
        ? Promise.resolve()
        : chrome.tabs.sendMessage(tab.id, { type: 'config:changed', config }),
    ),
  )
}

function assertConfig(value) {
  if (!isConfig(value)) {
    throw new Error(
      'Backend config must contain a followedHandles string array.',
    )
  }
}

function isConfig(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray(value.followedHandles) &&
    value.followedHandles.every((handle) => typeof handle === 'string')
  )
}

function assertCapture(value) {
  if (
    typeof value !== 'object' ||
    value === null ||
    !Array.isArray(value.posts) ||
    typeof value.observedAt !== 'string'
  ) {
    throw new Error('Invalid capture payload.')
  }
}

function assertStatus(value) {
  if (
    typeof value !== 'object' ||
    value === null ||
    !Number.isSafeInteger(value.postCount) ||
    value.postCount < 0
  ) {
    throw new Error('Backend status must contain a non-negative postCount.')
  }
}

function assertEventsResult(value) {
  if (
    typeof value !== 'object' ||
    value === null ||
    !Array.isArray(value.events) ||
    !value.events.every(isCaptureEvent) ||
    !Number.isSafeInteger(value.totalPosts) ||
    value.totalPosts < 0
  ) {
    throw new Error('Backend events response is invalid.')
  }
}

function isCaptureEvent(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    Number.isSafeInteger(value.id) &&
    value.id >= 0 &&
    (value.kind === 'post' || value.kind === 'thread') &&
    typeof value.postId === 'string' &&
    value.postId.length > 0 &&
    typeof value.author === 'string' &&
    value.author.length > 0 &&
    typeof value.title === 'string' &&
    Number.isSafeInteger(value.replyCount) &&
    value.replyCount >= 0 &&
    typeof value.capturedAt === 'string'
  )
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

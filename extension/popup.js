const form = document.querySelector('#add-form')
const input = document.querySelector('#handle')
const list = document.querySelector('#handles')
const empty = document.querySelector('#empty')
const status = document.querySelector('#status')
const savedCount = document.querySelector('#saved-count')
const openLogButton = document.querySelector('#open-log')
const scrollStatus = document.querySelector('#scroll-status')
const stopScrollButton = document.querySelector('#stop-scroll')

let handles = []
let busy = false
let scrollRun = null

openLogButton.addEventListener('click', async () => {
  if (chrome.sidePanel?.open === undefined) {
    showStatus(
      'Reload XLog Capture in chrome://extensions to enable the capture log, then reopen this popup.',
      'error',
    )
    return
  }
  try {
    await chrome.sidePanel.open({
      windowId: chrome.windows.WINDOW_ID_CURRENT,
    })
    window.close()
  } catch (error) {
    showStatus(`Could not open capture log: ${errorMessage(error)}`, 'error')
  }
})

form.addEventListener('submit', (event) => {
  event.preventDefault()
  const handle = normalizeHandle(input.value)

  if (!isValidHandle(handle)) {
    showStatus(
      'Enter an X handle or profile URL (1–15 letters, numbers, or underscores).',
      'error',
    )
    return
  }

  if (handles.includes(handle)) {
    showStatus(`@${handle} is already followed.`, 'error')
    return
  }

  void save([...handles, handle], `Following @${handle}.`)
})

list.addEventListener('click', (event) => {
  const action = event.target.closest('[data-action][data-handle]')
  if (!action) {
    return
  }

  event.preventDefault()
  if (busy) return

  const handle = action.dataset.handle
  switch (action.dataset.action) {
    case 'open':
      void openProfile(handle)
      break
    case 'scroll':
      void startScrolling(handle)
      break
    case 'remove':
      removeProfile(handle)
      break
  }
})

stopScrollButton.addEventListener('click', () => {
  if (!busy) void stopScrolling()
})

const scrollPoll = setInterval(() => void refreshScrollStatus(), 1_000)
window.addEventListener('unload', () => clearInterval(scrollPoll), {
  once: true,
})

void load()

async function load() {
  setBusy(true)
  const [response, statusResponse, scrollResponse] = await Promise.all([
    sendMessage({ type: 'config:get' }),
    sendMessage({ type: 'status:get' }),
    sendMessage({ type: 'scroll:status' }),
  ])
  setBusy(false)
  renderSavedCount(statusResponse)
  renderScrollStatus(scrollResponse)

  if (!response.ok) {
    showStatus(response.error, 'error')
    render()
    return
  }

  handles = response.data.followedHandles
    .map(normalizeHandle)
    .filter(isValidHandle)
  render()
  if (response.data.stale) {
    showStatus(`Showing cached configuration. ${response.data.error}`, 'error')
  } else {
    showStatus('Connected to the local XLog service.', 'success')
  }
}

async function openProfile(handle) {
  setBusy(true)
  showStatus(`Opening @${handle}…`)
  const response = await sendMessage({ type: 'profile:open', handle })
  setBusy(false)

  if (!response.ok) {
    showStatus(`Could not open @${handle}: ${response.error}`, 'error')
    return
  }

  window.close()
}

async function startScrolling(handle) {
  setBusy(true)
  showStatus(`Starting scrolling for @${handle}…`)
  const response = await sendMessage({ type: 'scroll:start', handle })
  setBusy(false)

  if (!response.ok) {
    showStatus(`Could not start scrolling: ${response.error}`, 'error')
    return
  }

  window.close()
}

function removeProfile(handle) {
  const confirmed = window.confirm(
    `Stop following @${handle}?\n\nSaved posts and images will be retained.`,
  )
  if (!confirmed) return

  void save(
    handles.filter((candidate) => candidate !== handle),
    `Stopped following @${handle}. Saved posts were retained.`,
  )
}

async function stopScrolling() {
  setBusy(true)
  showStatus('Stopping scrolling…')
  const response = await sendMessage({ type: 'scroll:stop' })
  setBusy(false)

  if (!response.ok) {
    showStatus(`Could not stop scrolling: ${response.error}`, 'error')
    return
  }

  renderScrollStatus(response)
  showStatus('Scrolling stopped.', 'success')
}

async function refreshScrollStatus() {
  renderScrollStatus(await sendMessage({ type: 'scroll:status' }))
}

function renderScrollStatus(response) {
  if (!response.ok) {
    scrollStatus.textContent = `Scrolling status unavailable: ${response.error}`
    scrollStatus.dataset.kind = 'error'
    stopScrollButton.hidden = true
    return
  }

  scrollRun = response.data.run
  if (scrollRun === null) {
    scrollStatus.textContent =
      'Choose the robot beside a profile. Scrolling runs for up to five minutes and stops when you press a mouse button.'
    scrollStatus.dataset.kind = 'idle'
    stopScrollButton.hidden = true
    return
  }

  const phase = formatPhase(scrollRun.phase)
  scrollStatus.textContent = `${phase} @${scrollRun.handle}. Stops after five minutes or when you press a mouse button.`
  scrollStatus.dataset.kind = 'active'
  stopScrollButton.hidden = false
}

function formatPhase(phase) {
  if (typeof phase !== 'string' || phase.length === 0) return 'Scrolling'
  return `${phase[0].toUpperCase()}${phase.slice(1)}`
}

async function save(nextHandles, successMessage) {
  setBusy(true)
  showStatus('Saving…')
  const response = await sendMessage({
    type: 'config:put',
    config: { followedHandles: nextHandles },
  })
  setBusy(false)

  if (!response.ok) {
    showStatus(response.error, 'error')
    return
  }

  handles = response.data.followedHandles
    .map(normalizeHandle)
    .filter(isValidHandle)
  input.value = ''
  render()
  await refreshSavedCount()
  showStatus(successMessage, 'success')
}

async function refreshSavedCount() {
  renderSavedCount(await sendMessage({ type: 'status:get' }))
}

function renderSavedCount(response) {
  if (!response.ok) {
    savedCount.textContent = 'Saved post count unavailable'
    savedCount.dataset.kind = 'error'
    return
  }

  const postCount = response.data.postCount
  savedCount.textContent = `${postCount} ${postCount === 1 ? 'post' : 'posts'} saved`
  savedCount.dataset.kind = 'success'
}

function render() {
  list.replaceChildren(
    ...handles.map((handle) => {
      const item = document.createElement('li')
      const name = document.createElement('a')
      const actions = document.createElement('span')
      const scroll = document.createElement('button')
      const remove = document.createElement('button')
      name.textContent = `@${handle}`
      name.href = `https://x.com/${handle}`
      name.className = 'profile-link'
      name.dataset.action = 'open'
      name.dataset.handle = handle
      name.title = `Open @${handle} in this tab`
      actions.className = 'profile-actions'
      scroll.type = 'button'
      scroll.className = 'icon-button scroll-button'
      scroll.dataset.action = 'scroll'
      scroll.dataset.handle = handle
      scroll.textContent = '🤖'
      scroll.setAttribute('aria-label', `Start scrolling @${handle}`)
      scroll.title = `Start scrolling @${handle}`
      remove.type = 'button'
      remove.className = 'icon-button remove-button'
      remove.dataset.action = 'remove'
      remove.dataset.handle = handle
      remove.textContent = '🗑'
      remove.setAttribute('aria-label', `Stop following @${handle}`)
      remove.title = `Stop following @${handle}`
      actions.append(scroll, remove)
      item.append(name, actions)
      return item
    }),
  )
  empty.hidden = handles.length > 0
}

function setBusy(nextBusy) {
  busy = nextBusy
  input.disabled = busy
  form.querySelector('button').disabled = busy
  for (const button of list.querySelectorAll('button')) {
    button.disabled = busy
  }
  stopScrollButton.disabled = busy
}

function showStatus(message, kind = 'info') {
  status.textContent = message
  status.dataset.kind = kind
}

function normalizeHandle(value) {
  if (typeof value !== 'string') return ''
  const candidate = value.trim()
  if (/^https?:\/\//i.test(candidate)) {
    try {
      const url = new URL(candidate)
      if (url.hostname !== 'x.com' && url.hostname !== 'www.x.com') return ''
      const parts = url.pathname.split('/').filter(Boolean)
      return parts.length === 1 ? parts[0].toLowerCase() : ''
    } catch {
      return ''
    }
  }
  return candidate.replace(/^@/, '').toLowerCase()
}

function isValidHandle(handle) {
  return /^[a-z0-9_]{1,15}$/.test(handle)
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message })
        return
      }

      resolve(
        response ?? {
          ok: false,
          error: 'The extension background service did not respond.',
        },
      )
    })
  })
}

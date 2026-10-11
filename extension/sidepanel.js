const POLL_INTERVAL_MS = 2_000

const connection = document.querySelector('#connection')
const empty = document.querySelector('#empty')
const eventList = document.querySelector('#events')
const total = document.querySelector('#total')

let loading = false
let lastSnapshot = ''

void refresh()
const pollTimer = setInterval(() => void refresh(), POLL_INTERVAL_MS)

window.addEventListener('pagehide', () => clearInterval(pollTimer), {
  once: true,
})

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    void refresh()
  }
})

async function refresh() {
  if (loading || document.visibilityState !== 'visible') {
    return
  }

  loading = true
  const response = await sendMessage({ type: 'events:get' })
  loading = false

  if (!response.ok) {
    renderOffline(response.error)
    return
  }

  renderEvents(response.data)
}

function renderEvents(data) {
  total.textContent = `${data.totalPosts} ${data.totalPosts === 1 ? 'post' : 'posts'}`
  connection.textContent = 'Live · newest first'
  connection.dataset.kind = 'success'
  empty.hidden = data.events.length > 0
  eventList.hidden = data.events.length === 0

  const snapshot = JSON.stringify(data.events)
  if (snapshot === lastSnapshot) {
    return
  }

  lastSnapshot = snapshot
  eventList.replaceChildren(...data.events.map(createEventItem))
}

function renderOffline(message) {
  lastSnapshot = ''
  total.textContent = 'Unavailable'
  connection.textContent = message
  connection.dataset.kind = 'error'
  empty.hidden = true
  eventList.hidden = true
  eventList.replaceChildren()
}

function createEventItem(event) {
  const item = document.createElement('li')
  const meta = document.createElement('p')
  const kind = document.createElement('span')
  const author = document.createElement('span')
  const capturedAt = document.createElement('time')
  const title = document.createElement('a')

  item.className = 'event'
  meta.className = 'event-meta'
  kind.className = 'event-kind'
  kind.dataset.kind = event.kind
  kind.textContent = formatKind(event)
  author.textContent = formatAuthor(event.author)
  capturedAt.dateTime = event.capturedAt
  capturedAt.textContent = formatTime(event.capturedAt)
  title.className = 'event-title'
  title.href = postUrl(event)
  title.target = '_blank'
  title.rel = 'noreferrer'
  title.textContent = event.title || `Post ${event.postId}`
  title.setAttribute('aria-label', `${title.textContent} — open on X`)

  meta.append(kind, author, '·', capturedAt)
  item.append(meta, title)
  return item
}

function formatKind(event) {
  if (event.kind === 'thread') {
    return `Thread · ${event.replyCount} ${event.replyCount === 1 ? 'reply' : 'replies'}`
  }

  return 'Post'
}

function formatAuthor(author) {
  return author.startsWith('@') ? author : `@${author}`
}

function formatTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return 'Unknown time'
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function postUrl(event) {
  const handle = event.author.replace(/^@/, '')
  return `https://x.com/${encodeURIComponent(handle)}/status/${encodeURIComponent(event.postId)}`
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

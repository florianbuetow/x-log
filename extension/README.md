# XLog Capture extension

This unpacked Manifest V3 extension passively reads posts that X has already rendered while you browse. It does not navigate, scroll, click, or make requests to X.

## Load locally

1. Start the XLog local service on `127.0.0.1:4318`.
2. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
3. Select this `extension` directory.
4. Pin **XLog Capture** and use its toolbar popup to add or remove followed handles.
5. Choose **Open capture log** in the popup to keep a live, newest-first log in Chrome's side panel.

The popup reads and writes `GET/PUT /api/config`. On followed profile and thread pages, the content script sends rendered posts to `POST /api/captures`. The side panel polls `GET /api/events?limit=100` through the extension service worker every two seconds while it is open; it never makes requests to X. The toolbar badge shows the total saved post count from `GET /api/status`; `999+` caps large display values, and a red `!` means the local service is unavailable. Configuration is cached only to keep capture working during a temporary local-service outage; changes always require a successful backend response.

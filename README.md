# XLog

Keep a local archive of the posts from the X accounts you follow, collected while you browse.

XLog has two parts: a Chrome extension that records the posts X already renders in your browser, and a small local service that stores them in a SQLite database on your machine. The extension uses your existing browser session and never reads your login credentials. The service only listens on `127.0.0.1`.

## What it does

- Saves posts from the profiles of followed accounts as you visit them.
- Saves the root post and up to 20 observed replies when you open a post's conversation.
- Downloads the images of original posts to disk.
- Can scroll a profile for you (up to five minutes) so more posts get rendered and captured.
- Shows live capture activity in a side panel and the saved post count on the toolbar badge.

## Quick start

You need Node.js 24.0.0+, npm, [just](https://github.com/casey/just), and Chrome.

```bash
npm install
just build
node dist/index.js init-feed data/x-feed.sqlite
just start
```

`just start` runs the service in the background and writes its log to `data/service.log`; `just stop` stops it. A new feed follows nobody, so add the accounts you want in the extension popup.

The extension stores nothing itself. It sends every capture to the local service at `http://127.0.0.1:4318`, so the service must be running whenever you browse X, or nothing is saved. The service also accepts browser requests only from a Chrome extension, so other web pages cannot write to your archive.

The extension is not published in the Chrome Web Store, so load it from disk while the service runs:

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository's `extension/` directory.
3. Pin the extension to get a toolbar button.

Visit the profile of a followed account on X and the posts start landing in the archive. After you change extension files, click **Reload** on its card and refresh open X tabs.

## Using the extension

The popup loads the followed-account list from the service.

- Click a handle to open its profile in the current tab.
- Click **🤖** to open the profile and start scrolling. Each visible batch is sent to the service before the next step. Press a mouse button on the page, press Escape, or use **Stop XLog scrolling** to stop. Switching tabs, leaving the page, and capture errors also stop the run. Only one run can be active, and runs do not resume after a restart.
- Click **🗑** to unfollow a handle. Saved posts and images stay.
- Click **Open capture log** to watch captures live.

## Where your data lives

| Path                             | Contents                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| `data/x-feed.sqlite`             | Followed handles, posts keyed by X status ID, thread reply links, capture events, image metadata |
| `data/media/<handle>/<post-id>/` | Downloaded images, named after X's media ID, position, and URL hash                              |

`data/` is ignored by git. Images in replies and quoted posts, videos, and avatars are not saved, and each image is limited to 10 MiB. The service makes one extra request to X's public image CDN per new image and retries failures on a later observation.

While the service runs, you can inspect the archive in a browser:

- <http://127.0.0.1:4318/api/archive> for all saved posts, including `images`
- <http://127.0.0.1:4318/api/status> for counts
- <http://127.0.0.1:4318/api/events?limit=100> for the newest capture events
- <http://127.0.0.1:4318/api/config> for the followed handles

To move an older JSON archive into SQLite, run `just stop` and then:

```bash
node dist/index.js migrate-feed data/x-feed.json data/x-feed.sqlite
```

The JSON file stays as a backup, and the command refuses to overwrite an existing database.

## Limits

- Posts are saved only while you browse the relevant pages. The extension cannot load unseen posts, so the archive may miss posts, may not hold the chronologically first 20 replies, and does not update while X is closed.
- Scrolling captures rendered profile posts and does not open conversations. Varied timing does not guarantee that X treats the activity as human.
- X may change its page structure, and a local extension does not remove account risk.
- [X's terms](https://x.com/en/tos) prohibit scraping without prior written consent. Review them before using this with your account. For complete scheduled retrieval, use an authorized X API route or obtain permission.

## Command line

```text
xlog init-feed <db>             Create a new SQLite feed
xlog migrate-feed <json> <db>   Copy a JSON feed archive into SQLite
xlog serve <db>                 Serve the feed API on 127.0.0.1:4318
xlog summarize <file>           Summarize the numbers in <file>, one per line
xlog summarize -                Summarize the numbers read from stdin
xlog --help                     Show usage
```

Results go to stdout and diagnostics to stderr. Exit codes: `0` success, `1` runtime failure, `2` usage error.

## Development

Code lives in layers, and each layer may only import from the one below it:

```text
src/index.ts      executable entrypoint
src/lib.ts        public programmatic API
      │
      ▼
src/cli/          arguments, streams, usage, exit codes
      │
      ▼
src/application/  use cases over raw input
      │
      ▼
src/domain/       pure business behavior
```

Tests live in `test/`: `unit/` for each layer, `property/` for fast-check properties, `types/` for the public TypeScript contract, `cli/` for the built CLI as a black box, `package/` for the packed `npm pack` artifact, and `extension/` for the extension.

Tool configuration (TypeScript, Prettier, oxlint, Vitest, Stryker, knip, dependency-cruiser, ts-archunit, Gitleaks, Semgrep, codespell, CodeQL) lives in `config/`. Only `.semgrepignore` stays at the root, because Semgrep reads it only from there.

All project commands run through `just`:

```bash
just init       # install dependencies, activate the pre-commit hook
just test       # run all tests
just start      # build and start the feed service in the background
just stop       # stop the feed service
just ci         # run every validation check
just help       # list every command
```

`just ci` needs these tools on top of Node.js: [Semgrep](https://semgrep.dev/), [codespell](https://github.com/codespell-project/codespell), the [CodeQL CLI](https://codeql.github.com/), [Gitleaks](https://github.com/gitleaks/gitleaks), [ShellCheck](https://www.shellcheck.net/), and [shfmt](https://github.com/mvdan/sh). Everything runs locally, with no containers or hosted services. `just ci-quiet` runs the same checks with compact output and is installed as the pre-commit hook.

CI runs each gate once: prerequisites, install, format, build, and the secrets scan run first, then the independent checks run in parallel on at most four workers (`just --set ci_jobs 2 ci` changes that). Every step's wall time is printed and saved to `reports/ci-timings.tsv`. Mutation testing is incremental: Stryker keeps its results in `reports/stryker-incremental.json` and reuses them for unchanged source and tests. The cache is discarded when `package.json`, `package-lock.json`, the Node version, or the Stryker, Vitest, or TypeScript configs change, and `just destroy` removes it. See [AGENTS.md](AGENTS.md) for the project rules.

## License

MIT — see [LICENSE](LICENSE).

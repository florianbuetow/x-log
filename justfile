# =============================================================================
# Justfile Rules:
# 1. Use printf for colored or formatted output.
# 2. Add an empty @echo "" before and after every command block.
# 3. Keep help ordered by lifecycle, run/build, quality, then tests.
# 4. Composite recipes fail fast.
# 5. Every recipe ends with a clear success or failure status.
# =============================================================================

codeql_pack_version := "2.4.7"

feed_db := "data/x-feed.sqlite"
feed_pid := "data/service.pid"
feed_log := "data/service.log"
ci_jobs := "4"

_default:
    @just help

check:
    @echo ""
    @if ! command -v node >/dev/null 2>&1; then \
        printf "\033[31m✗ Error: node is not installed\033[0m\n"; \
        printf "  Install Node.js 24.0.0+: https://nodejs.org/\n"; \
        echo ""; \
        exit 1; \
    fi
    @node -e 'const required = "24.0.0".split(".").map(Number); const actual = process.versions.node.split(".").map(Number); for (let index = 0; index < required.length; index += 1) { if (actual[index] > required[index]) process.exit(0); if (actual[index] < required[index]) { console.error("\x1b[31m✗ Error: Node.js 24.0.0+ required, found " + process.versions.node + "\x1b[0m"); process.exit(1); } }'
    @printf "\033[32m✓ node is installed\033[0m\n"
    @node --version | sed 's/^/  /'
    @if ! command -v npm >/dev/null 2>&1; then \
        printf "\033[31m✗ Error: npm is not installed\033[0m\n"; \
        printf "  npm ships with Node.js: https://nodejs.org/\n"; \
        echo ""; \
        exit 1; \
    fi
    @printf "\033[32m✓ npm is installed\033[0m\n"
    @if ! command -v codespell >/dev/null 2>&1; then \
        printf "\033[31m✗ Error: codespell is not installed\033[0m\n"; \
        printf "  Install with: brew install codespell\n"; \
        echo ""; \
        exit 1; \
    fi
    @printf "\033[32m✓ codespell is installed\033[0m\n"
    @if ! command -v semgrep >/dev/null 2>&1; then \
        printf "\033[31m✗ Error: semgrep is not installed\033[0m\n"; \
        printf "  Install with: brew install semgrep\n"; \
        echo ""; \
        exit 1; \
    fi
    @printf "\033[32m✓ semgrep is installed\033[0m\n"
    @if ! command -v codeql >/dev/null 2>&1; then \
        printf "\033[31m✗ Error: codeql is not installed\033[0m\n"; \
        printf "  Install with: brew install codeql\n"; \
        echo ""; \
        exit 1; \
    fi
    @printf "\033[32m✓ codeql is installed\033[0m\n"
    @if ! command -v gitleaks >/dev/null 2>&1; then \
        printf "\033[31m✗ Error: gitleaks is not installed\033[0m\n"; \
        printf "  Install with: brew install gitleaks\n"; \
        echo ""; \
        exit 1; \
    fi
    @printf "\033[32m✓ gitleaks is installed\033[0m\n"
    @if ! command -v shellcheck >/dev/null 2>&1; then \
        printf "\033[31m✗ Error: shellcheck is not installed\033[0m\n"; \
        printf "  Install with: brew install shellcheck\n"; \
        echo ""; \
        exit 1; \
    fi
    @printf "\033[32m✓ shellcheck is installed\033[0m\n"
    @if ! command -v shfmt >/dev/null 2>&1; then \
        printf "\033[31m✗ Error: shfmt is not installed\033[0m\n"; \
        printf "  Install with: brew install shfmt\n"; \
        echo ""; \
        exit 1; \
    fi
    @printf "\033[32m✓ shfmt is installed\033[0m\n"
    @echo ""

help:
    @clear
    @echo ""
    @printf "\033[0;34m=== xlog ===\033[0m\n"
    @echo ""
    @printf "\033[0;33mSetup & Lifecycle:\033[0m\n"
    @printf "  %-40s %s\n" "init" "Install dependencies and activate the pre-commit hook"
    @printf "  %-40s %s\n" "destroy" "Remove dependencies and generated artifacts"
    @printf "  %-40s %s\n" "check" "Check prerequisites"
    @printf "  %-40s %s\n" "help" "Show this help message"
    @echo ""
    @printf "\033[0;33mRun & Build:\033[0m\n"
    @printf "  %-40s %s\n" "start" "Build and start the feed service in the background"
    @printf "  %-40s %s\n" "stop" "Stop the feed service"
    @printf "  %-40s %s\n" "build" "Compile production JavaScript"
    @echo ""
    @printf "\033[0;33mCode Quality:\033[0m\n"
    @printf "  %-40s %s\n" "code-format" "Auto-format code with Prettier"
    @printf "  %-40s %s\n" "code-style" "Check formatting and lint with Prettier + oxlint"
    @printf "  %-40s %s\n" "code-spell" "Check spelling with codespell"
    @printf "  %-40s %s\n" "code-shell" "Check repository shell scripts with shfmt + ShellCheck"
    @printf "  %-40s %s\n" "code-semgrep" "Run custom guardrails with Semgrep"
    @printf "  %-40s %s\n" "code-lspchecks" "Run strict TypeScript checks"
    @printf "  %-40s %s\n" "code-security" "Run the dedicated security lint pass"
    @printf "  %-40s %s\n" "code-secrets" "Scan for committed secrets with Gitleaks"
    @printf "  %-40s %s\n" "code-deptry" "Check dependency and dead-code hygiene with knip"
    @printf "  %-40s %s\n" "code-architecture" "Check import boundaries with dependency-cruiser"
    @printf "  %-40s %s\n" "code-architecture-deep" "Check deep architecture rules with ts-archunit"
    @printf "  %-40s %s\n" "code-package" "Check package structure with publint, attw, and npm pack"
    @printf "  %-40s %s\n" "code-codeql" "Run local CodeQL data-flow analysis"
    @printf "  %-40s %s\n" "code-codeql-sync" "Prefetch CodeQL query packs once (needs network)"
    @echo ""
    @printf "\033[0;33mCI & Testing:\033[0m\n"
    @printf "  %-40s %s\n" "test" "Run unit, property, type, CLI, and package tests"
    @printf "  %-40s %s\n" "test-coverage" "Run tests with 80%% coverage thresholds"
    @printf "  %-40s %s\n" "test-mutation" "Run StrykerJS with a 80%% mutation score threshold"
    @printf "  %-40s %s\n" "ci" "Run every validation check in parallel, verbose, with per-step wall times"
    @printf "  %-40s %s\n" "ci-quiet" "Run every validation check in parallel, fail-fast, compact output"
    @echo ""

init: check
    @echo ""
    @printf "\033[34m=== Initializing Development Environment ===\033[0m\n"
    @if ! git rev-parse --git-dir >/dev/null 2>&1; then git init -q; fi
    @npm install
    @if [ ! -f ".git/hooks/pre-commit" ]; then \
        printf "\033[31m✗ Error: .git/hooks/pre-commit is missing\033[0m\n"; \
        printf "  Re-apply the template or restore the generated hook.\n"; \
        echo ""; \
        exit 1; \
    fi
    @chmod +x .git/hooks/pre-commit
    @printf "\033[32m✓ init completed successfully\033[0m\n"
    @echo ""


# Start the feed service in the background
start: build
    #!/usr/bin/env bash
    set -euo pipefail
    echo ""
    printf "\033[34m=== Starting Feed Service ===\033[0m\n"
    if [ -f "{{feed_pid}}" ]; then
        pid=$(cat "{{feed_pid}}")
        command=$(ps -p "$pid" -o command= 2>/dev/null || true)
        if [[ "$command" == *"dist/index.js serve"* ]]; then
            printf "\033[31m✗ start failed: service already running (pid %s)\033[0m\n" "$pid"
            echo ""
            exit 1
        fi
        rm -f "{{feed_pid}}"
    fi
    if [ ! -f "{{feed_db}}" ]; then
        printf "\033[31m✗ start failed: %s does not exist\033[0m\n" "{{feed_db}}"
        printf "  Create it with: node dist/index.js init-feed %s\n" "{{feed_db}}"
        echo ""
        exit 1
    fi
    nohup node dist/index.js serve "{{feed_db}}" >"{{feed_log}}" 2>&1 </dev/null &
    pid=$!
    echo "$pid" >"{{feed_pid}}"
    for _ in $(seq 1 50); do
        if ! kill -0 "$pid" 2>/dev/null; then
            rm -f "{{feed_pid}}"
            printf "\033[31m✗ start failed: service exited, see {{feed_log}}\033[0m\n"
            cat "{{feed_log}}"
            echo ""
            exit 1
        fi
        if grep -q "listening" "{{feed_log}}"; then
            printf "  pid %s, log {{feed_log}}\n" "$pid"
            printf "\033[32m✓ start completed successfully\033[0m\n"
            echo ""
            exit 0
        fi
        sleep 0.1
    done
    printf "\033[31m✗ start failed: service did not report listening within 5s\033[0m\n"
    echo ""
    exit 1

# Stop the feed service
stop:
    #!/usr/bin/env bash
    set -euo pipefail
    echo ""
    printf "\033[34m=== Stopping Feed Service ===\033[0m\n"
    if [ ! -f "{{feed_pid}}" ]; then
        printf "\033[32m✓ stop completed: service was not running\033[0m\n"
        echo ""
        exit 0
    fi
    pid=$(cat "{{feed_pid}}")
    command=$(ps -p "$pid" -o command= 2>/dev/null || true)
    if [[ "$command" != *"dist/index.js serve"* ]]; then
        rm -f "{{feed_pid}}"
        printf "\033[32m✓ stop completed: service was not running (removed stale pid file)\033[0m\n"
        echo ""
        exit 0
    fi
    kill "$pid"
    for _ in $(seq 1 50); do
        if ! kill -0 "$pid" 2>/dev/null; then
            rm -f "{{feed_pid}}"
            printf "\033[32m✓ stop completed successfully\033[0m\n"
            echo ""
            exit 0
        fi
        sleep 0.1
    done
    printf "\033[31m✗ stop failed: pid %s did not exit within 5s\033[0m\n" "$pid"
    echo ""
    exit 1


build:
    @echo ""
    @printf "\033[34m=== Building for Production ===\033[0m\n"
    @npm run build
    @printf "\033[32m✓ build completed successfully\033[0m\n"
    @echo ""

destroy:
    @echo ""
    @printf "\033[34m=== Cleaning Generated Artifacts ===\033[0m\n"
    @rm -rf node_modules dist coverage reports .stryker-tmp .codeql-db *.tgz
    @printf "\033[32m✓ destroy completed successfully\033[0m\n"
    @echo ""

code-format:
    @echo ""
    @printf "\033[34m=== Formatting Code ===\033[0m\n"
    @npx prettier --config config/prettierrc.json --ignore-path config/prettierignore --log-level warn --write .
    @printf "\033[32m✓ code-format completed successfully\033[0m\n"
    @echo ""

code-style:
    @echo ""
    @printf "\033[34m=== Checking Code Style ===\033[0m\n"
    @npx prettier --config config/prettierrc.json --ignore-path config/prettierignore --log-level warn --check .
    @npx oxlint --deny-warnings -c config/oxlint/oxlintrc.json
    @printf "\033[32m✓ code-style completed successfully\033[0m\n"
    @echo ""

code-spell:
    @echo ""
    @printf "\033[34m=== Checking Spelling ===\033[0m\n"
    @codespell src test config scripts *.md --ignore-words=config/codespell/ignore.txt
    @printf "\033[32m✓ code-spell completed successfully\033[0m\n"
    @echo ""


code-shell:
    #!/usr/bin/env bash
    set -euo pipefail
    echo ""
    printf "\033[34m=== Checking Shell Scripts ===\033[0m\n"
    scripts=()
    while IFS= read -r script; do
        scripts+=("$script")
    done < <(find scripts -type f -name '*.sh' | sort)
    if [ "${#scripts[@]}" -eq 0 ]; then
        printf "  no shell scripts found in scripts/\n"
    else
        shfmt -d "${scripts[@]}"
        shellcheck "${scripts[@]}"
    fi
    printf "\033[32m✓ code-shell completed successfully\033[0m\n"
    echo ""


code-semgrep:
    @echo ""
    @printf "\033[34m=== Running Semgrep Guardrails ===\033[0m\n"
    @semgrep --config config/semgrep/ --error src test scripts
    @printf "\033[32m✓ code-semgrep completed successfully\033[0m\n"
    @echo ""

code-lspchecks:
    @echo ""
    @printf "\033[34m=== Running Type Checks ===\033[0m\n"
    @npx tsc -p config/tsconfig.json
    @printf "\033[32m✓ code-lspchecks completed successfully\033[0m\n"
    @echo ""

code-security:
    @echo ""
    @printf "\033[34m=== Running Security Lint Pass ===\033[0m\n"
    @npx oxlint --deny-warnings -c config/oxlint/security.oxlintrc.json src
    @printf "\033[32m✓ code-security completed successfully\033[0m\n"
    @echo ""

code-secrets:
    @echo ""
    @printf "\033[34m=== Scanning for Secrets ===\033[0m\n"
    @gitleaks dir . --config config/gitleaks.toml --no-banner --redact
    @printf "\033[32m✓ code-secrets completed successfully\033[0m\n"
    @echo ""

code-deptry:
    @echo ""
    @printf "\033[34m=== Checking Dependency and Dead-Code Hygiene ===\033[0m\n"
    @npx knip --config config/knip.json
    @printf "\033[32m✓ code-deptry completed successfully\033[0m\n"
    @echo ""

code-architecture:
    @echo ""
    @printf "\033[34m=== Checking Import Boundaries ===\033[0m\n"
    @npx depcruise src test --config config/dependency-cruiser.cjs
    @printf "\033[32m✓ code-architecture completed successfully\033[0m\n"
    @echo ""

code-architecture-deep:
    @echo ""
    @printf "\033[34m=== Checking Deep Architecture Rules ===\033[0m\n"
    @npx ts-archunit check config/arch.rules.ts
    @printf "\033[32m✓ code-architecture-deep completed successfully\033[0m\n"
    @echo ""

code-package: build
    @echo ""
    @printf "\033[34m=== Checking Package Correctness ===\033[0m\n"
    @npx publint --strict
    @npx attw --pack . --profile esm-only
    @npm pack --dry-run
    @printf "\033[32m✓ code-package completed successfully\033[0m\n"
    @echo ""

code-codeql:
    #!/usr/bin/env bash
    set -euo pipefail
    echo ""
    printf "\033[34m=== Running CodeQL Data-Flow Analysis ===\033[0m\n"
    pack_dir="$HOME/.codeql/packages/codeql/javascript-queries/{{codeql_pack_version}}"
    if [ ! -f "$pack_dir/codeql-pack.lock.yml" ] || [ ! -d "$pack_dir/.codeql/libraries" ] || [ ! -d "$HOME/.codeql/packages/codeql/javascript-all" ]; then
        printf "\033[31m✗ Error: CodeQL query packs are not cached locally\033[0m\n"
        printf "  Run: just code-codeql-sync  (requires network; needs running once per machine)\n"
        echo ""
        exit 1
    fi
    rm -rf .codeql-db
    mkdir -p reports
    ram_mb=$(node -p 'Math.floor(require("node:os").totalmem() * 3 / 4 / 1024 / 1024)')
    codeql database create .codeql-db --language=javascript-typescript --source-root=src --threads=8 --overwrite --verbosity=warnings
    codeql database analyze .codeql-db "codeql/javascript-queries@{{codeql_pack_version}}:codeql-suites/javascript-security-extended.qls" --format=sarif-latest --output=reports/codeql.sarif --threads=8 --ram="$ram_mb" --verbosity=warnings
    node -e 'const sarif = JSON.parse(require("node:fs").readFileSync("reports/codeql.sarif", "utf8")); const results = sarif.runs.flatMap((run) => run.results); for (const result of results) { const location = result.locations?.[0]?.physicalLocation; console.error(`${result.ruleId}: ${result.message.text} (src/${location?.artifactLocation?.uri}:${location?.region?.startLine})`); } if (results.length > 0) { console.error(`\x1b[31m✗ CodeQL reported ${results.length} finding(s)\x1b[0m`); process.exit(1); }'
    printf "\033[32m✓ code-codeql completed successfully\033[0m\n"
    echo ""

code-codeql-sync:
    #!/usr/bin/env bash
    set -euo pipefail
    echo ""
    printf "\033[34m=== Prefetching CodeQL Query Packs ===\033[0m\n"
    mkdir -p "$HOME/.codeql"
    pack_dir="$HOME/.codeql/packages/codeql/javascript-queries/{{codeql_pack_version}}"
    pack_locked="$pack_dir/codeql-pack.lock.yml"
    deps_cached="$HOME/.codeql/packages/codeql/javascript-all"
    if [ -f "$pack_locked" ] && [ -d "$pack_dir/.codeql/libraries" ] && [ -d "$deps_cached" ]; then
        printf "  query packs already cached in %s\n" "$HOME/.codeql/packages"
        printf "\033[32m✓ code-codeql-sync completed successfully\033[0m\n"
        echo ""
        exit 0
    fi
    codeql pack download codeql/javascript-queries@{{codeql_pack_version}}
    dependencies=$(sed -n '/^dependencies:/,/^[a-z][a-z]*:/p' "$pack_dir/qlpack.yml" | grep 'codeql/' | sed 's/^ *//; s/: *@*/@/; s/- *uses: //' | tr -d '"')
    if [ -z "$dependencies" ]; then
        printf "\033[31m✗ Error: unable to read pack dependencies from %s\033[0m\n" "$pack_dir/qlpack.yml"
        echo ""
        exit 1
    fi
    # shellcheck disable=SC2086 -- dependency list must split into pack specs
    codeql pack download $dependencies
    rm -f "$pack_locked"
    codeql pack install "$pack_dir"
    printf "\033[32m✓ code-codeql-sync completed successfully\033[0m\n"
    echo ""

test: build
    @echo ""
    @printf "\033[34m=== Running Tests ===\033[0m\n"
    @npm run test
    @printf "\033[32m✓ test completed successfully\033[0m\n"
    @echo ""

test-coverage: build
    @echo ""
    @printf "\033[34m=== Running Tests with Coverage ===\033[0m\n"
    @npm run test:coverage
    @printf "\033[32m✓ test-coverage completed successfully\033[0m\n"
    @echo ""

test-mutation: build
    #!/usr/bin/env bash
    set -euo pipefail
    echo ""
    printf "\033[34m=== Running Mutation Tests ===\033[0m\n"
    # Stryker reuses results for unchanged source and tests, but cannot see
    # dependency or configuration changes. Discard the cache when those change.
    incremental="reports/stryker-incremental.json"
    keyfile="reports/stryker-incremental.key"
    mkdir -p reports
    key=$({
        cat package.json package-lock.json config/stryker.config.json \
            config/vitest.config.ts config/tsconfig.json config/tsconfig.build.json
        node --version
    } | shasum -a 256 | cut -d' ' -f1)
    if [ ! -f "$keyfile" ] || [ "$(cat "$keyfile")" != "$key" ]; then
        printf "  cache key changed or missing, discarding %s\n" "$incremental"
        rm -f "$incremental" "$keyfile"
    fi
    status=0
    npm run test:mutation || status=$?
    if [ -f "$incremental" ]; then
        printf '%s\n' "$key" >"$keyfile"
    fi
    if [ "$status" -ne 0 ]; then
        printf "\033[31m✗ test-mutation failed\033[0m\n"
        echo ""
        exit "$status"
    fi
    printf "\033[32m✓ test-mutation completed successfully\033[0m\n"
    echo ""

# Run every CI gate once, with independent checks in parallel (override with: just --set ci_jobs 2 ci)
ci:
    #!/usr/bin/env bash
    set -e
    echo ""
    printf "\033[34m=== Running CI Checks ===\033[0m\n"
    echo ""
    if ! scripts/ci.sh --jobs {{ci_jobs}} --verbose; then
        echo ""
        printf "\033[31m✗ ci failed\033[0m\n"
        echo ""
        exit 1
    fi
    echo ""
    printf "\033[32m✓ ci completed successfully\033[0m\n"
    echo ""

# Same checks as ci, printing only each step's result and the output of failures
ci-quiet:
    #!/usr/bin/env bash
    set -e
    printf "\033[34m=== Running CI Checks (Quiet Mode) ===\033[0m\n"
    if ! scripts/ci.sh --jobs {{ci_jobs}}; then
        printf "\033[31m✗ ci-quiet failed\033[0m\n"
        exit 1
    fi
    echo ""
    printf "\033[32m✓ ci-quiet completed successfully\033[0m\n"
    echo ""

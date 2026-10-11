#!/usr/bin/env bash
# Runs every CI gate once: a serial setup phase, then the independent checks in
# a bounded worker pool. Records the wall time of every step.
#
# Usage: scripts/ci.sh --jobs <1-16> [--verbose]
set -eo pipefail
set -m
cd "$(dirname "$0")/.."

LOG_DIR="reports/ci"
TIMINGS_FILE="reports/ci-timings.tsv"
MAX_JOBS=16
# Steps that prepare or rewrite the tree. They finish before the pool starts.
# code-secrets scans the whole tree, so it runs before Stryker creates sandboxes.
SETUP_STEPS=(check init code-format build code-secrets)
# Independent gates, slowest first so the pool does not end waiting on one long step.
POOL_STEPS=(test-mutation code-codeql test-coverage code-package code-semgrep
	code-lspchecks code-architecture-deep code-deptry code-architecture code-style
	code-security code-spell code-shell)

usage_error() {
	printf "\033[31m✗ ci failed: %s\033[0m\n" "$1" >&2
	printf "  Usage: scripts/ci.sh --jobs <1-%s> [--verbose]\n" "$MAX_JOBS" >&2
	exit 2
}

now_ms() {
	perl -MTime::HiRes=time -e 'printf "%d", time() * 1000'
}

seconds() {
	awk -v ms="$1" 'BEGIN { printf "%.1f", ms / 1000 }'
}

jobs=""
verbose=0
while [ $# -gt 0 ]; do
	case "$1" in
	--jobs)
		[ $# -ge 2 ] || usage_error "--jobs needs a value"
		jobs="$2"
		shift 2
		;;
	--verbose)
		verbose=1
		shift
		;;
	*) usage_error "unknown argument: $1" ;;
	esac
done
[ -n "$jobs" ] || usage_error "--jobs is required"
case "$jobs" in
*[!0-9]*) usage_error "--jobs must be a whole number, got: $jobs" ;;
esac
if [ "$jobs" -lt 1 ] || [ "$jobs" -gt "$MAX_JOBS" ]; then
	usage_error "--jobs must be between 1 and $MAX_JOBS, got: $jobs"
fi

rm -rf "$LOG_DIR"
mkdir -p "$LOG_DIR"

done_steps=()
done_ms=()
done_status=()
running_pids=()
running_steps=()
running_starts=()
failed_step=""
total_start=$(now_ms)

write_timings() {
	local index
	: >"$TIMINGS_FILE"
	for index in "${!done_steps[@]}"; do
		printf '%s\t%s\t%s\n' "${done_steps[$index]}" "${done_ms[$index]}" \
			"${done_status[$index]}" >>"$TIMINGS_FILE"
	done
}

run_step() {
	local step=$1 start end status=0
	start=$(now_ms)
	just --no-deps "$step" >"$LOG_DIR/$step.log" 2>&1 || status=$?
	end=$(now_ms)
	printf '%s\t%s\n' "$((end - start))" "$status" >"$LOG_DIR/$step.result"
}

finish_step() {
	local step=$1 ms status
	IFS=$'\t' read -r ms status <"$LOG_DIR/$step.result"
	done_steps+=("$step")
	done_ms+=("$ms")
	done_status+=("$status")
	if [ "$status" -eq 0 ]; then
		printf "\033[32m✓ %s passed (%ss)\033[0m\n" "$step" "$(seconds "$ms")"
		if [ "$verbose" -eq 1 ]; then
			sed 's/^/    /' "$LOG_DIR/$step.log"
		fi
	else
		printf "\033[31m✗ %s failed (%ss)\033[0m\n" "$step" "$(seconds "$ms")"
		cat "$LOG_DIR/$step.log"
		if [ -z "$failed_step" ]; then
			failed_step=$step
		fi
	fi
}

cancel_running() {
	local index now
	now=$(now_ms)
	for index in "${!running_pids[@]}"; do
		kill -TERM -- "-${running_pids[$index]}" 2>/dev/null || true
		wait "${running_pids[$index]}" 2>/dev/null || true
		done_steps+=("${running_steps[$index]}")
		done_ms+=("$((now - running_starts[index]))")
		done_status+=("cancelled")
		printf "\033[33m- %s cancelled\033[0m\n" "${running_steps[$index]}"
	done
	running_pids=()
	running_steps=()
	running_starts=()
}

on_interrupt() {
	cancel_running
	write_timings
	printf "\033[31m✗ ci interrupted\033[0m\n"
	exit 130
}
trap on_interrupt INT TERM

fail() {
	cancel_running
	write_timings
	printf "\033[31m✗ ci failed: %s\033[0m\n" "$failed_step"
	exit 1
}

for step in "${SETUP_STEPS[@]}"; do
	run_step "$step"
	finish_step "$step"
	if [ -n "$failed_step" ]; then
		fail
	fi
done

queue=("${POOL_STEPS[@]}")
next=0
while [ "$next" -lt "${#queue[@]}" ] || [ "${#running_pids[@]}" -gt 0 ]; do
	while [ "$next" -lt "${#queue[@]}" ] && [ "${#running_pids[@]}" -lt "$jobs" ]; do
		step=${queue[$next]}
		next=$((next + 1))
		run_step "$step" &
		running_pids+=("$!")
		running_steps+=("$step")
		running_starts+=("$(now_ms)")
	done

	still_pids=()
	still_steps=()
	still_starts=()
	for index in "${!running_pids[@]}"; do
		if kill -0 "${running_pids[$index]}" 2>/dev/null; then
			still_pids+=("${running_pids[$index]}")
			still_steps+=("${running_steps[$index]}")
			still_starts+=("${running_starts[$index]}")
		else
			wait "${running_pids[$index]}" 2>/dev/null || true
			finish_step "${running_steps[$index]}"
		fi
	done
	running_pids=("${still_pids[@]}")
	running_steps=("${still_steps[@]}")
	running_starts=("${still_starts[@]}")

	if [ -n "$failed_step" ]; then
		fail
	fi
	sleep 0.2
done

total_ms=$(($(now_ms) - total_start))
write_timings

printf "\n\033[34m=== CI Wall Time ===\033[0m\n"
awk -F'\t' -v wall="$total_ms" '
  { printf "  %-26s %8.1fs\n", $1, $2 / 1000; sum += $2
    if ($2 > slowest) { slowest = $2; name = $1 } }
  END {
    printf "  %-26s %8.1fs\n", "wall time", wall / 1000
    printf "  %-26s %8.1fs (%.1fx overlap)\n", "sum of steps", sum / 1000, sum / wall
    printf "  %-26s %s, %.0f%% of wall time\n", "slowest step", name, slowest * 100 / wall
  }' "$TIMINGS_FILE"
if [ -f "$LOG_DIR/test-mutation.log" ]; then
	score=$(awk -F'|' '/^All files/ { gsub(/ /, "", $2); print $2; exit }' "$LOG_DIR/test-mutation.log")
	printf "  %-26s %s\n" "mutation score" "${score:-unknown}"
fi

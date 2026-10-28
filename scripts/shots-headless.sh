#!/usr/bin/env bash
# Headless screenshot harness for GameVault Experimental.
#
# Every capture runs Electron inside its own Xvfb server (xvfb-run -a), so
# nothing is ever drawn on the real display. This script only writes PNGs to
# screenshots/audit/; it does not touch application source or user data.
#
# Usage:
#   scripts/shots-headless.sh            # capture all known states
#   scripts/shots-headless.sh home detail # capture selected states
#   scripts/shots-headless.sh --list     # print available states
#   scripts/shots-headless.sh --help
#
# Per-state contract: timeout 70, --wait 7000, --shot-delay 4000, output must
# exist and be larger than 20 KB.

set -u

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd -- "$ROOT_DIR" || { echo "ERROR: cannot enter $ROOT_DIR" >&2; exit 1; }

ELECTRON="./node_modules/.bin/electron"
OUT_DIR="screenshots/audit"
LOG_DIR="${TMPDIR:-/tmp}/gamevault-shot-audit-logs"
WAIT_MS=7000
SHOT_DELAY_MS=4000
TIMEOUT_SECS=70
MIN_BYTES=20480   # "> 20KB"

# The state list mirrors the dev hook in src/app.js. "home" is the initial
# window with no --shot-state argument.
STATES=(
  home
  gridview
  import
  importmenu
  importdemo
  fallshelf
  connectclick
  detail
  settings
  editmodal
)

usage() {
  cat <<'EOF'
Headless screenshot harness for GameVault Experimental.

Usage:
  scripts/shots-headless.sh [--list] [state ...]

  --list       Print the available states, one per line, and exit.
  -h, --help   Show this help.

With no state arguments all known states are captured. Captures are written to
screenshots/audit/<state>.png using:
  xvfb-run -a ./node_modules/.bin/electron . \
    --shot screenshots/audit/<state>.png \
    --wait 7000 --shot-delay 4000 [--shot-state <state>]

"home" is captured without --shot-state. Each run is bounded by timeout 70.
The script refuses to start when the filesystem has less than 2 GB free.
EOF
}

list_states() {
  local state
  for state in "${STATES[@]}"; do
    printf '%s\n' "$state"
  done
}

is_known_state() {
  local needle="$1" state
  for state in "${STATES[@]}"; do
    [[ "$state" == "$needle" ]] && return 0
  done
  return 1
}

# --- argument parsing -------------------------------------------------------
declare -a REQUESTED=()
while (($#)); do
  case "$1" in
    --list)
      list_states
      exit 0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      while (($#)); do REQUESTED+=("$1"); shift; done
      break
      ;;
    -*)
      echo "ERROR: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      REQUESTED+=("$1")
      shift
      ;;
  esac
done

if ((${#REQUESTED[@]} == 0)); then
  REQUESTED=("${STATES[@]}")
fi

# --- preflight --------------------------------------------------------------
if [[ ! -x "$ELECTRON" ]]; then
  echo "ERROR: Electron binary is missing or not executable: $ELECTRON" >&2
  exit 1
fi

if ! command -v xvfb-run >/dev/null 2>&1; then
  echo "ERROR: xvfb-run is required but not installed." >&2
  exit 1
fi

if ! command -v timeout >/dev/null 2>&1; then
  echo "ERROR: coreutils timeout is required but not installed." >&2
  exit 1
fi

AVAIL_KB="$(df -Pk -- "$ROOT_DIR" 2>/dev/null | awk 'NR == 2 {print $4}')"
if [[ ! "$AVAIL_KB" =~ ^[0-9]+$ ]]; then
  echo "ERROR: could not determine free disk space for $ROOT_DIR" >&2
  exit 1
fi

AVAIL_HUMAN="$(df -Ph -- "$ROOT_DIR" | awk 'NR == 2 {print $4}')"
if ((AVAIL_KB < 2 * 1024 * 1024)); then
  echo "STOP: free space on $ROOT_DIR is ${AVAIL_HUMAN} (< 2G)." >&2
  echo "STOP: refusing to capture screenshots; free at least 2 GB and retry." >&2
  exit 1
fi
echo "Disk free: ${AVAIL_HUMAN} (need > 2G) — OK"

mkdir -p -- "$OUT_DIR" "$LOG_DIR"

# --- capture ----------------------------------------------------------------
FAILED=0
CAPTURED=0
declare -a FAILED_STATES=()

printf 'Capturing %d state(s): %s\n' "${#REQUESTED[@]}" "${REQUESTED[*]}"

for STATE in "${REQUESTED[@]}"; do
  OUT="$OUT_DIR/$STATE.png"
  LOG="$LOG_DIR/$STATE.log"

  if ! is_known_state "$STATE"; then
    echo "WARN: '$STATE' is not in the known state list; attempting capture anyway."
  fi

  rm -f -- "$OUT"
  rm -f -- "$LOG"

  CMD=("$ELECTRON" . --shot "$OUT" --wait "$WAIT_MS" --shot-delay "$SHOT_DELAY_MS")
  if [[ "$STATE" != "home" ]]; then
    CMD+=(--shot-state "$STATE")
  fi

  echo "--- [$STATE] timeout ${TIMEOUT_SECS}s xvfb-run -a ${CMD[*]}"
  START_TS="$(date +%s)"
  timeout "$TIMEOUT_SECS" xvfb-run -a "${CMD[@]}" >"$LOG" 2>&1
  RC=$?
  ELAPSED=$(( $(date +%s) - START_TS ))

  if ((RC == 124)); then
    echo "  timeout after ${TIMEOUT_SECS}s"
  elif ((RC != 0)); then
    echo "  electron exited with code $RC"
  fi

  SIZE=0
  if [[ -f "$OUT" ]]; then
    SIZE="$(stat -c '%s' -- "$OUT" 2>/dev/null || echo 0)"
  fi

  PNG_MAGIC=""
  if ((SIZE > 0)); then
    PNG_MAGIC="$(head -c 8 -- "$OUT" 2>/dev/null | od -An -tx1 | tr -d ' \n')"
  fi

  if ((SIZE > MIN_BYTES)) && [[ "$PNG_MAGIC" == "89504e470d0a1a0a" ]]; then
    CAPTURED=$((CAPTURED + 1))
    echo "  OK: $OUT (${SIZE} bytes, ${ELAPSED}s)"
  else
    FAILED=$((FAILED + 1))
    FAILED_STATES+=("$STATE")
    if [[ ! -f "$OUT" ]]; then
      echo "  FAIL: $OUT was not created (${ELAPSED}s); log: $LOG"
    elif [[ "$PNG_MAGIC" != "89504e470d0a1a0a" ]]; then
      echo "  FAIL: $OUT is not a PNG (${SIZE} bytes); log: $LOG"
    else
      echo "  FAIL: $OUT is only ${SIZE} bytes (must be > ${MIN_BYTES}); log: $LOG"
    fi
    tail -n 8 -- "$LOG" 2>/dev/null | sed 's/^/    /'
  fi
done

# --- summary ----------------------------------------------------------------
echo
echo "Captured ${CAPTURED}/${#REQUESTED[@]} state(s) into $OUT_DIR"
if ((FAILED > 0)); then
  echo "Failed states: ${FAILED_STATES[*]}"
  echo "Logs: $LOG_DIR"
  exit 1
fi

echo "All captures passed the >20KB PNG check."

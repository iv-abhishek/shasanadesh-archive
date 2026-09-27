#!/usr/bin/env bash
# Schedule the daily sync on this Mac with launchd (ADR-055).
#
#   ./scripts/install-daily-sync.sh              install, runs daily at 02:30 (local time)
#   ./scripts/install-daily-sync.sh 03:15        another time
#   ./scripts/install-daily-sync.sh 02:30 --ingest   also fetch (only once ingestion resumes)
#   ./scripts/install-daily-sync.sh --print      show the job file without installing
#   ./scripts/install-daily-sync.sh --uninstall  remove the schedule
#
# launchd runs a missed job when the Mac wakes, so a sleeping Mac catches up in
# the morning. The job does not keep the Mac awake.
#
# macOS privacy: ~/Downloads, ~/Documents and ~/Desktop are protected. A launchd
# job reading the project there fails with "Operation not permitted" unless the
# node binary shown below has Full Disk Access (System Settings › Privacy &
# Security), or the project lives elsewhere (e.g. ~/projects/shasanadesh).
set -euo pipefail

LABEL="in.shasanadesh.daily-sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Daily sync schedule removed."
  exit 0
fi

PRINT=0
TIME="02:30"
EXTRA=""
for arg in "$@"; do
  case "$arg" in
    --print) PRINT=1 ;;
    --ingest) EXTRA="<string>--ingest</string>" ;;
    [0-2][0-9]:[0-5][0-9]) TIME="$arg" ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done
HOUR=$((10#${TIME%%:*}))
MINUTE=$((10#${TIME##*:}))
if (( HOUR > 23 )); then echo "Invalid time: $TIME" >&2; exit 1; fi

NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then echo "node not found on PATH" >&2; exit 1; fi
# launchd starts with a bare PATH: carry node (nvm), Homebrew (tesseract,
# pdftoppm, postgres) and the system tools.
JOB_PATH="$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
mkdir -p "$ROOT/data/sync"

xml_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }

JOB="<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$NODE")</string>
    <string>$(xml_escape "$ROOT/scripts/daily-sync.mjs")</string>
    $EXTRA
  </array>
  <key>WorkingDirectory</key><string>$(xml_escape "$ROOT")</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$(xml_escape "$JOB_PATH")</string></dict>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>$HOUR</integer><key>Minute</key><integer>$MINUTE</integer></dict>
  <key>StandardOutPath</key><string>$(xml_escape "$ROOT/data/sync/launchd.log")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$ROOT/data/sync/launchd.log")</string>
  <key>LowPriorityIO</key><true/>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>"

if (( PRINT )); then
  echo "$JOB"
  exit 0
fi

mkdir -p "$(dirname "$PLIST")"
printf '%s\n' "$JOB" > "$PLIST"
plutil -lint "$PLIST" >/dev/null
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "Daily sync scheduled at $TIME (${EXTRA:+with ingestion}${EXTRA:-processing only})."
echo "  job file: $PLIST"
echo "  node:     $NODE   (give it Full Disk Access if the project is under ~/Downloads)"
echo "  reports:  $ROOT/data/sync/reports/"
echo "Run it now: launchctl kickstart gui/$(id -u)/$LABEL"

#!/bin/bash
# The launchd entry point, copied to ~/.config/vet402-daily/launch.sh at registration (outside the repository,
# so it is there even when the checkout is not). It starts scripts/daily/run.sh <mode>; when that file is
# missing or not executable it writes one line to the alert file named in ~/.config/vet402-daily/env and shows
# a notification, so a missing checkout is not a silent skip.
#
#   ~/.config/vet402-daily/launch.sh am|pm|records|board|proxy-alerts|catchup
export PATH="/usr/bin:/bin:/usr/sbin:/sbin"
: "${HOME:=$(cd ~ && pwd)}"
CONF="$HOME/.config/vet402-daily"
RUN="${VET402_RUN_SH:-$HOME/vet402-solana/scripts/daily/run.sh}"
if [ -x "$RUN" ]; then
  exec "$RUN" "$@"
fi
ALERTS=""
if [ -f "$CONF/env" ]; then
  ALERTS="$(sed -n 's/^VET402_ALERTS_FILE=//p' "$CONF/env" | tail -1)"
fi
msg="${1:-?} did not run: $RUN is missing or not executable (main not pulled into ~/vet402-solana?)"
if [ -n "$ALERTS" ]; then
  printf '\n%s\n' "## ⚠️ [$(TZ=Asia/Tokyo /bin/date '+%Y-%m-%d %H:%M')] [vet402_daily] $msg" >>"$ALERTS"
fi
if [ "${VET402_DAILY_NOTIFY:-1}" = 1 ]; then
  /usr/bin/osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title "vet402 daily"' -e 'end run' "$msg" >/dev/null 2>&1 || true
fi
echo "$msg" >&2
exit 3

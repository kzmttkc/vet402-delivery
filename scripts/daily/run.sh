#!/bin/bash
# vet402 daily runner, started by launchd (scripts/daily/launchd/). One fixed order, no judgment calls:
#
#   scripts/daily/run.sh am       10:17 JST  Solana, then Tempo: remeasure (one purchase per payTo), then publish
#   scripts/daily/run.sh pm       22:17 JST  Solana only, the second purchase per payTo (--per-payto 2), then publish
#   scripts/daily/run.sh records  09:05 JST  the UTC day that just closed: build-receipts --day, verify-receipt on
#                                            every record, publish-records --day, anchor-receipts --day --send,
#                                            publish. Does nothing until the daily-records code is on main.
#   add --dry-run (or VET402_DAILY_DRY=1): remeasure --dry-run only, the anchor only simulated, records built in a
#   scratch copy, the data commit made in the publish worktree and checked by the pre-push hook, never pushed.
#
# Before paying: main is pulled, the published tree passes the secret gate, no other remeasure or anchor is in
# flight, and the dry run of the same chain fits the run cap, the month and the balance (scripts/daily/steps.ts).
# Publishing: result files are copied into data/ through the secret gate (known shapes redacted with the wording
# data/ already uses; anything else it finds stops the commit), data/manifest.json is updated, rank and site are
# rebuilt, typecheck and npm test run, and one commit with data/ and site/ only is pushed (the pre-push review gate
# lets data-only commits through). Then the Pages run for that commit is awaited.
#
# Any failure, cap, refusal or unknown secret stops the run without paying again: one line goes to the alert
# file and a macOS notification is shown. A stop after money could have moved, or a refused plan, also writes
# HALT-<lane> in the state folder, and later runs of that lane stop until a person has looked and removed it.
# A refused plan (over a cap) still publishes what the chains before it bought; a failed or stopped --pay run
# publishes nothing.
# Only one run at a time (lockf on the state folder's lock). Nothing runs on or after VET402_DAILY_END (JST).
#
# Settings (environment, or KEY=value lines in ~/.config/vet402-daily/env, which stays outside the repository):
#   VET402_REPO          checkout on main that pays and anchors (keys in .keys/)  default ~/vet402-solana
#   VET402_PUBLISH_WT    worktree the data commits are made in (created detached)  default ~/vet402-solana-publish
#   VET402_RECEIPTS      signed records, the one place anchor-receipts reads     default ~/vet402-solana-receipt/results/receipts
#   VET402_ALERTS_FILE   file that gets one line per stop                         default <logs>/ALERTS.md
#   VET402_DAILY_LOGS    default ~/Library/Logs/vet402-daily
#   VET402_DAILY_STATE   lock, HALT files, plans                                  default ~/.local/state/vet402-daily
#   VET402_DAILY_END     first JST day with no runs                               default 2026-10-09
#   VET402_DAILY_NOTIFY  0 turns the macOS notification off
#   VET402_DAILY_NOW     epoch seconds to use as now (tests)

# Everything runs inside main(), read in full before it starts, so a git pull that rewrites this file
# mid-run changes nothing until the next run.
main() {
  set -uo pipefail
  umask 077
  export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  : "${HOME:=$(cd ~ && pwd)}"
  export HOME
  local SELF_DIR
  SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  SELF="$SELF_DIR/$(basename "${BASH_SOURCE[0]}")"

  MODE="${1:-}"
  shift || true
  DRY="${VET402_DAILY_DRY:-0}"
  local a
  for a in "$@"; do
    case "$a" in
      --dry-run) DRY=1 ;;
      *) echo "usage: run.sh am|pm|records [--dry-run]" >&2; return 2 ;;
    esac
  done
  case "$MODE" in
    am | pm) LANE=pay ;;
    records) LANE=records ;;
    *) echo "usage: run.sh am|pm|records [--dry-run]" >&2; return 2 ;;
  esac

  local envfile="$HOME/.config/vet402-daily/env"
  if [ -f "$envfile" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$envfile"
    set +a
  fi
  REPO="${VET402_REPO:-$HOME/vet402-solana}"
  PUB="${VET402_PUBLISH_WT:-$HOME/vet402-solana-publish}"
  RECEIPTS="${VET402_RECEIPTS:-$HOME/vet402-solana-receipt/results/receipts}"
  RMDIR="$HOME/vet402-solana/results/remeasure" # RM_PROD_DIR (src/remeasure/constants.ts), fixed in code
  KEYS="${VET402_KEYS:-$REPO/.keys}"
  BRANCH="${VET402_REPO_BRANCH:-main}"   # another branch only for a dry run of unmerged code
  BASE="${VET402_PUBLISH_BASE:-origin/main}"
  LOGDIR="${VET402_DAILY_LOGS:-$HOME/Library/Logs/vet402-daily}"
  STATE="${VET402_DAILY_STATE:-$HOME/.local/state/vet402-daily}"
  ALERTS="${VET402_ALERTS_FILE:-$LOGDIR/ALERTS.md}"
  END_DAY="${VET402_DAILY_END:-2026-10-09}"
  NOW="${VET402_DAILY_NOW:-$(/bin/date +%s)}"
  GIT=/usr/bin/git
  NODE=/opt/homebrew/bin/node
  NPM=/opt/homebrew/bin/npm
  GH=/opt/homebrew/bin/gh
  TSX="${VET402_TSX:-$REPO/node_modules/.bin/tsx}"  # never npx: it could fetch a package
  GH_REPO="kzmttkc/vet402-delivery"
  mkdir -p "$LOGDIR" "$STATE"
  LOG="$LOGDIR/$(TZ=Asia/Tokyo /bin/date -r "$NOW" +%Y-%m-%d)-$MODE.log"
  exec >>"$LOG" 2>&1

  JST_DAY="$(TZ=Asia/Tokyo /bin/date -r "$NOW" +%Y-%m-%d)"
  UTC_DAY="$(/bin/date -u -r "$NOW" +%Y-%m-%d)"
  UTC_HM="$(/bin/date -u -r "$NOW" +%H%M)"

  if [[ "$JST_DAY" > "$END_DAY" || "$JST_DAY" == "$END_DAY" ]]; then
    log "JST $JST_DAY is on or after $END_DAY: nothing runs"
    return 0
  fi

  # One run at a time. lockf holds a kernel lock for the child's whole life; a crash releases it.
  local LOCK="$STATE/run.lock"
  if [ "${VET402_DAILY_LOCKED:-}" != "$LOCK" ]; then
    log "start $MODE$([ "$DRY" = 1 ] && echo ' (dry run)')"
    local args=("$MODE")
    [ "$DRY" = 1 ] && args+=(--dry-run)
    VET402_DAILY_LOCKED="$LOCK" VET402_DAILY_NOW="$NOW" VET402_DAILY_DRY="$DRY" /usr/bin/lockf -k -t 0 "$LOCK" /bin/bash "$SELF" "${args[@]}"
    local rc=$?
    if [ $rc -eq 75 ]; then
      alert "another daily run holds $LOCK; this $MODE run did nothing"
    fi
    log "end $MODE rc=$rc"
    return $rc
  fi

  if [ -f "$STATE/HALT-$LANE" ]; then
    alert "the $LANE lane is halted since an earlier stop ($STATE/HALT-$LANE: $(head -c 300 "$STATE/HALT-$LANE" | tr '\n' ' ')). Look, then remove the file"
    return 1
  fi

  ALERTED=0
  local rc=0
  case "$MODE" in
    am) pay_lane 1 "solana tempo" || rc=$? ;;
    pm) pay_lane 2 "solana" || rc=$? ;;
    records) records_lane || rc=$? ;;
  esac
  # Fail loud: a stop that did not say why still says that it stopped.
  if [ $rc -ne 0 ] && [ "$ALERTED" = 0 ]; then
    alert "stopped at a step that gave no reason (exit $rc); see the log" halt
  fi
  return $rc
}

log() { printf '%s %s\n' "$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

notify() {
  [ "${VET402_DAILY_NOTIFY:-1}" = 1 ] || return 0
  /usr/bin/osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title "vet402 daily"' -e 'end run' "$1" >/dev/null 2>&1 || true
}

# alert <message> [halt]: one line in the alert file, a notification, and for halt the lane's HALT file.
alert() {
  local when line
  when="$(TZ=Asia/Tokyo /bin/date '+%Y-%m-%d %H:%M')"
  line="## ⚠️ [$when] [vet402_daily] $MODE stopped$([ "$DRY" = 1 ] && echo ' (dry run)'): $1 (log: $LOG)"
  log "STOP: $1"
  ALERTED=1
  mkdir -p "$(dirname "$ALERTS")"
  printf '\n%s\n' "$line" >>"$ALERTS"
  notify "$MODE stopped: $1"
  if [ "${2:-}" = halt ]; then
    printf '%s\n' "$line" >"$STATE/HALT-$LANE"
  fi
}

# run <what> <command...>: log the command's output; nonzero exit is returned.
run() {
  local what="$1"
  shift
  log "> $what"
  "$@"
}

in_repo() { (cd "$REPO" && "$@"); }
in_pub() { (cd "$PUB" && "$@"); }
# The gate and the decisions always run from REPO's code (main), whatever the publish worktree holds.
gate() { in_repo "$TSX" scripts/daily/secret-gate.ts "$@" --keys-dir "$KEYS"; }
daily_steps() { in_repo "$TSX" scripts/daily/steps.ts "$@"; }

# ---------- preflight (nothing paid yet: a stop here does not halt) ----------

preflight_repo() {
  local branch
  branch="$($GIT -C "$REPO" symbolic-ref --short HEAD 2>/dev/null)"
  [ "$branch" = "$BRANCH" ] || { alert "$REPO is on '$branch', not $BRANCH"; return 1; }
  [ -z "$($GIT -C "$REPO" status --porcelain --untracked-files=no)" ] || { alert "$REPO has uncommitted changes to tracked files"; return 1; }
  run "git fetch" $GIT -C "$REPO" fetch -q origin || { alert "git fetch in $REPO failed"; return 1; }
  if [ "$BRANCH" = main ]; then
    run "git pull main" $GIT -C "$REPO" pull -q --ff-only origin main || { alert "git pull --ff-only in $REPO failed"; return 1; }
    [ "$($GIT -C "$REPO" rev-parse HEAD)" = "$($GIT -C "$REPO" rev-parse origin/main)" ] || { alert "$REPO main is not origin/main after the pull"; return 1; }
  else
    [ "$DRY" = 1 ] || { alert "VET402_REPO_BRANCH=$BRANCH is for dry runs only"; return 1; }
    log "dry run from branch $BRANCH at $($GIT -C "$REPO" rev-parse --short HEAD): no pull"
  fi
}

preflight_pub() {
  if [ ! -d "$PUB" ]; then
    run "create the publish worktree" $GIT -C "$REPO" worktree add -q --detach "$PUB" "$BASE" || { alert "could not create $PUB"; return 1; }
  fi
  [ -z "$($GIT -C "$PUB" status --porcelain)" ] || { alert "$PUB is not clean (an earlier run left changes)"; return 1; }
  run "publish worktree to $BASE" $GIT -C "$PUB" checkout -q --detach "$BASE" || { alert "checkout in $PUB failed"; return 1; }
  local want have
  want="$(/usr/bin/shasum -a 256 "$PUB/package-lock.json" | cut -c1-64)"
  have="$(cat "$PUB/node_modules/.daily-lock-sha" 2>/dev/null || true)"
  if [ "$want" != "$have" ]; then
    run "npm ci in $PUB" in_pub $NPM ci --no-audit --no-fund || { alert "npm ci in $PUB failed"; return 1; }
    mkdir -p "$PUB/node_modules" && echo "$want" >"$PUB/node_modules/.daily-lock-sha" || { alert "could not stamp $PUB/node_modules"; return 1; }
  fi
}

# The whole public tree, before any money moves: a publish that could not pass must not be paid for.
gate_tree() {
  run "secret gate on $PUB (data, site)" gate scan "$PUB" data site || {
    alert "secret gate: the public tree in $PUB has findings that are not allowed (see log)" ${1:-}
    return 1
  }
}

no_inflight() {
  local f
  for f in "$RMDIR"/solana.lock "$RMDIR"/tempo.lock; do
    [ -e "$f" ] && { alert "a remeasure lock is present ($f): another --pay run, or one that was killed"; return 1; }
  done
  for f in "$RECEIPTS"/*/anchor-sent.json; do
    [ -f "$f" ] || continue
    if grep -q '"status": *"sending"' "$f"; then
      alert "an anchor is in flight ($f is at \"sending\"): run anchor-receipts --resume by hand"
      return 1
    fi
  done
}

# Payments must start and end inside one UTC day, before the records run reads it (00:05 UTC).
pay_window() {
  if [ "$UTC_HM" -lt 0030 ] || [ "$UTC_HM" -ge 2200 ]; then
    alert "UTC $UTC_HM is outside the pay window 00:30-22:00 UTC; nothing paid"
    return 1
  fi
}

# ---------- am / pm ----------

pay_lane() {
  local per="$1" chains="$2" c
  pay_window || return 1
  preflight_repo || return 1
  preflight_pub || return 1
  gate_tree || return 1
  no_inflight || return 1
  local rc=0
  for c in $chains; do
    remeasure "$c" "$per" || { rc=$?; break; }
  done
  # 1: a chain's plan was refused before paying: no more payments, but what earlier chains bought is published.
  # 2: a --pay run failed or stopped: nothing more, not even the publish, until a person has looked.
  [ $rc -eq 2 ] && return 2
  publish_remeasure || return $?
  return $rc
}

remeasure() {
  local chain="$1" per="$2" plan="$STATE/plan" start rc verdict
  rm -rf "$plan" && mkdir -p "$plan"
  run "remeasure $chain dry run" in_repo $NPM run -s remeasure -- --chain "$chain" --dry-run --per-payto "$per" --out "$plan" || {
    alert "remeasure --chain $chain --dry-run failed; nothing paid"
    return 1
  }
  local file
  file="$(ls "$plan"/"$chain"-*.dry-run.json 2>/dev/null | tail -1)"
  [ -n "$file" ] || { alert "remeasure $chain wrote no plan; nothing paid"; return 1; }
  verdict="$(daily_steps check-plan "$file" --chain "$chain" --day "$UTC_DAY" --per-payto "$per")"
  rc=$?
  log "plan: $verdict"
  if [ $rc -eq 10 ]; then return 0; fi
  if [ $rc -ne 0 ]; then
    alert "not paying: $verdict" halt
    return 1
  fi
  if [ "$DRY" = 1 ]; then
    log "dry run: would pay now (remeasure --chain $chain --pay --per-payto $per)"
    return 0
  fi
  start="$(/bin/date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  run "remeasure $chain --pay" in_repo $NPM run -s remeasure -- --chain "$chain" --pay --per-payto "$per"
  rc=$?
  local out
  out="$(daily_steps run-outcome "$RMDIR/$chain-$UTC_DAY.json" --since "$start")"
  local orc=$?
  log "outcome: $out"
  if [ $rc -ne 0 ] || [ $orc -ne 0 ]; then
    alert "remeasure $chain --pay exit $rc: $out. Not paying again, not publishing" halt
    return 2
  fi
}

publish_remeasure() {
  local c src day copied=() redacted=()
  for c in solana tempo; do
    if [ "$DRY" = 1 ]; then
      # Nothing was paid: publish the newest existing day again, which must change nothing.
      src="$(ls "$RMDIR"/"$c"-????-??-??.json 2>/dev/null | sort | tail -1)"
    else
      src="$RMDIR/$c-$UTC_DAY.json"
    fi
    [ -n "$src" ] && [ -f "$src" ] || continue
    day="$(basename "$src" .json)"
    day="${day#"$c"-}"
    local res
    res="$(gate copy "$src" "$PUB/data/remeasure/$c-$day.json")" || {
      alert "secret gate stopped the copy of $(basename "$src") (see log); nothing published" halt
      return 1
    }
    log "copied $(basename "$src"): $res"
    local reds
    reds="$(printf '%s' "$res" | $NODE -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(JSON.parse(s).redactions)))')"
    [ "$reds" != "[]" ] && redacted+=("$c")
    run "manifest for $c-$day" daily_steps manifest "$PUB/data" --file "remeasure/$c-$day.json" --day "$day" --redactions "$reds" || {
      alert "manifest update for $c-$day failed" halt
      return 1
    }
    copied+=("$c")
  done
  if [ ${#copied[@]} -eq 0 ]; then
    log "no remeasure result for $UTC_DAY: nothing to publish"
    return 0
  fi
  local msg
  msg="$(daily_steps message "$PUB/data" --day "$day" --redacted "$(IFS=,; echo "${redacted[*]:-}")")" || {
    alert "could not write the commit message" halt
    return 1
  }
  publish "$msg"
}

# ---------- publish (shared): rank, site, gate, checks, one data/ + site/ commit, push, Pages ----------

publish() {
  local msg="$1" mdate rankdir="$STATE/rank"
  mdate="$($NODE -p 'require(process.argv[1]).date' "$PUB/data/manifest.json")"
  rm -rf "$rankdir"
  run "rank from data/" in_pub $NPM run -s rank -- --data data --offline --out "$rankdir" || { alert "rank failed" halt; return 1; }
  run "build site/" in_pub "$TSX" scripts/build-site.ts --report "$rankdir/rank-$mdate.json" --out site || { alert "build-site failed" halt; return 1; }
  gate_tree halt || return 1
  local changed others
  changed="$($GIT -C "$PUB" status --porcelain)"
  others="$(printf '%s\n' "$changed" | grep -v '^$' | grep -Ev '^.. (data|site)/' || true)"
  [ -z "$others" ] || { alert "the build changed files outside data/ and site/: $others" halt; return 1; }
  if [ -z "$($GIT -C "$PUB" status --porcelain -- data)" ]; then
    log "data/ unchanged: nothing to publish"
    $GIT -C "$PUB" checkout -q -- site 2>/dev/null
    $GIT -C "$PUB" clean -qfd -- site 2>/dev/null
    return 0
  fi
  run "typecheck" in_pub $NPM run -s typecheck || { alert "typecheck failed on the data commit" halt; return 1; }
  run "npm test" in_pub $NPM test --silent || { alert "npm test failed on the data commit" halt; return 1; }
  run "git add data site" $GIT -C "$PUB" add -- data site || { alert "git add failed" halt; return 1; }
  run "git commit" $GIT -C "$PUB" commit -q -m "$msg" || { alert "git commit failed" halt; return 1; }
  local sha base bad
  sha="$($GIT -C "$PUB" rev-parse HEAD)"
  base="$($GIT -C "$PUB" rev-parse origin/main)"
  bad="$($GIT -C "$PUB" diff-tree --no-commit-id --name-only -r "$sha" | grep -Ev '^(data|site)/' || true)"
  [ -z "$bad" ] || { alert "the commit touches files outside data/ and site/: $bad" halt; return 1; }
  local hook
  hook="$($GIT -C "$PUB" rev-parse --path-format=absolute --git-common-dir)/hooks/pre-push"
  [ -x "$hook" ] || { alert "the pre-push review gate is not installed ($hook)" halt; return 1; }
  log "> pre-push review gate on $base..$sha"
  printf 'refs/heads/main %s refs/heads/main %s\n' "$sha" "$base" | (cd "$PUB" && "$hook" origin "https://github.com/$GH_REPO.git") || {
    alert "the pre-push review gate refuses $sha" halt
    return 1
  }
  log "pre-push review gate: pass (data/ and site/ only)"
  log "commit $sha: $msg"
  if [ "$DRY" = 1 ]; then
    log "dry run: not pushed; $PUB back to $BASE"
    $GIT -C "$PUB" checkout -q --detach "$BASE"
    return 0
  fi
  run "push" $GIT -C "$PUB" push -q origin "$sha:refs/heads/main" || { alert "git push of $sha failed (not retried)" halt; return 1; }
  if [ "$BRANCH" = main ]; then
    run "pull main" $GIT -C "$REPO" pull -q --ff-only origin main || alert "pushed $sha, but $REPO did not fast-forward"
  fi
  wait_pages "$sha"
}

wait_pages() {
  local sha="$1" i status conclusion
  for i in $(seq 1 40); do
    sleep 30
    read -r status conclusion < <($GH run list --repo "$GH_REPO" --workflow pages.yml --commit "$sha" --json status,conclusion \
      --jq 'if length == 0 then "none none" else (.[0].status + " " + (.[0].conclusion // "none")) end' 2>/dev/null || echo "error error")
    if [ "$status" = completed ]; then
      if [ "$conclusion" = success ]; then
        log "Pages rebuilt for $sha"
        return 0
      fi
      alert "the Pages run for $sha ended $conclusion (data is pushed; the site may be stale)"
      return 1
    fi
  done
  alert "no finished Pages run for $sha after 20 minutes (last: $status)"
  return 1
}

# ---------- records ----------

records_lane() {
  preflight_repo || return 1
  if ! grep -q "assertDaySourcesCurrent" "$REPO/src/receipt/sources.ts" 2>/dev/null; then
    log "the daily-records code (src/receipt/sources.ts) is not on main yet: nothing to do"
    return 0
  fi
  local day
  day="$(/bin/date -u -r $((NOW - 86400)) +%Y-%m-%d)"
  if [ "$UTC_HM" -lt 0005 ]; then
    alert "UTC $UTC_HM: $day may not be closed yet"
    return 1
  fi
  if [ ! -f "$RMDIR/solana-$day.json" ] && [ ! -f "$RMDIR/tempo-$day.json" ]; then
    log "no remeasure purchases on $day: nothing to record"
    return 0
  fi
  no_inflight || return 1
  preflight_pub || return 1
  gate_tree || return 1

  local R="$RECEIPTS" anchor_from=()
  if [ "$DRY" = 1 ]; then
    # Never touch the real records in a dry run: build and simulate in a copy.
    R="$STATE/dry-receipts"
    rm -rf "$R" && mkdir -p "$R"
    [ -d "$RECEIPTS" ] && cp -R "$RECEIPTS"/. "$R"/
    anchor_from=(--from "$R")
  fi
  if [ -f "$R/$day/sources.json" ]; then
    log "$day is already built in $R"
  else
    run "build-receipts $day" in_repo "$TSX" scripts/build-receipts.ts --key "$KEYS/attest.json" --out "$R" --day "$day" || {
      alert "build-receipts --day $day failed" halt
      return 1
    }
  fi
  local f n=0
  for f in "$R/$day"/obs_*.json; do
    [ -f "$f" ] || continue
    n=$((n + 1))
    in_repo "$TSX" scripts/verify-receipt.ts "$f" >>"$STATE/verify-$day.log" 2>&1 || {
      alert "verify-receipt failed on $(basename "$f") (see $STATE/verify-$day.log)" halt
      return 1
    }
  done
  log "verify-receipt: $n records of $day pass"
  run "publish-records $day (before the anchor)" in_repo "$TSX" scripts/publish-records.ts --from "$R" --data "$PUB/data" --day "$day" || {
    alert "publish-records --day $day refused" halt
    return 1
  }
  if [ -f "$R/$day/anchor-sent.json" ]; then
    grep -q '"status": *"sent"' "$R/$day/anchor-sent.json" || { alert "$day anchor-sent.json is not \"sent\": resume by hand" halt; return 1; }
    log "$day root already anchored"
  elif [ "$DRY" = 1 ]; then
    run "anchor $day (simulate)" in_repo "$TSX" scripts/anchor-receipts.ts --day "$day" ${anchor_from[@]+"${anchor_from[@]}"} || { alert "anchor simulation for $day failed" halt; return 1; }
  else
    run "anchor $day --send" in_repo "$TSX" scripts/anchor-receipts.ts --day "$day" --send || { alert "anchor-receipts --day $day --send failed (not retried)" halt; return 1; }
  fi
  run "publish-records $day" in_repo "$TSX" scripts/publish-records.ts --from "$R" --data "$PUB/data" --day "$day" || {
    alert "publish-records --day $day refused after the anchor" halt
    return 1
  }
  publish "records: $day delivery records and the day's root$([ "$DRY" = 1 ] && echo ' (simulated anchor)' || echo ', anchored on Solana')"
}

main "$@"; exit $?

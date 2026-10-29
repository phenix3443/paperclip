write_header() {
  {
    echo "## server typecheck cache: $SCENARIO"
    echo
    echo "Runner: $(nproc) CPUs, $(free -m | awk '/Mem:/ {print $2}') MiB RAM. tsc $TSC_VERSION."
    echo "Test merge commit \`$GITHUB_SHA\`, head \`$HEAD_SHA\`. Run: $RUN_URL"
    echo "Restored files: $(find "$CACHE_DIR" -type f 2>/dev/null | wc -l)"
    echo
    echo "| scenario | phase | command | exit | peak RSS (MiB) | wall (s) | cache-hit | matched key | tsc --version | head SHA | run URL |"
    echo "|---|---|---|---|---|---|---|---|---|---|---|"
  } >> "$GITHUB_STEP_SUMMARY"
}

measure() {
  local phase="$1"; shift
  local log="$RUNNER_TEMP/$SCENARIO-$phase.log" code rss wall
  (cd server && /usr/bin/time -f '%M %e' -o "$RUNNER_TEMP/time.txt" "$@") > "$log" 2>&1
  code=$?
  read -r rss wall < <(tail -n 1 "$RUNNER_TEMP/time.txt") || { rss=0; wall=0; }
  local cmd="$*"
  cmd="${cmd//"$PWD/server/node_modules/.bin/"/}"
  echo "| $SCENARIO | $phase | \`$cmd\` | $code | $((rss / 1024)) | $wall | $CACHE_HIT | $MATCHED_KEY | $TSC_VERSION | $HEAD_SHA | $RUN_URL |" | tee -a "$GITHUB_STEP_SUMMARY"
  echo "::group::$phase (exit $code)"; tail -60 "$log"; echo "::endgroup::"
  return "$code"
}

status_reason() {
  local out
  out="$(cd server && "$(pnpm bin)/tsc" -b tsconfig.src.json --verbose --dry 2>&1)"
  echo "::group::tsc -b --verbose --dry"; echo "$out"; echo "::endgroup::"
  {
    echo
    echo "\`tsc -b tsconfig.src.json --verbose --dry\`:"
    echo '```text'
    echo "$out" | tail -n 8
    echo '```'
    echo
  } >> "$GITHUB_STEP_SUMMARY"
}

measure_phases() {
  local tsc
  tsc="$(cd server && pnpm bin)/tsc"
  status_reason
  measure src "$tsc" -b tsconfig.src.json --checkers 2 || return 1
  measure tests "$tsc" -p tsconfig.tests.json --checkers 2 || return 1
}

show_edit() {
  {
    echo "git diff --stat before the edit: ${1:-(clean)}"
    echo
    echo '```text'
    git diff --stat
    git diff
    echo '```'
  } >> "$GITHUB_STEP_SUMMARY"
}

append_line() {
  local before
  before="$(git diff --stat)"
  printf '\n%s\n' "$2" >> "$1"
  show_edit "$before"
}

expect_failure() {
  status_reason
  local log="$RUNNER_TEMP/$SCENARIO-typecheck.log"
  measure typecheck pnpm run typecheck
  local code=$?
  if [ "$code" -eq 0 ]; then
    echo "PROBE FAILED: typecheck exited 0 with an injected type error" | tee -a "$GITHUB_STEP_SUMMARY" >&2
    return 1
  fi
  local file_re="${1//./\\.}"
  if ! sed 's/\x1b\[[0-9;]*m//g' "$log" \
      | grep -E "(^|[ /])$file_re(\([0-9]+,[0-9]+\)|:[0-9]+:[0-9]+).*error"; then
    echo "PROBE FAILED: exit $code but no error reported in $1" | tee -a "$GITHUB_STEP_SUMMARY" >&2
    return 1
  fi
  echo "Probe passed: exit $code, error reported in \`$1\`." | tee -a "$GITHUB_STEP_SUMMARY"
}

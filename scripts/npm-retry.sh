#!/usr/bin/env sh
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -eu

attempts="${NEMOCLAW_NPM_RETRY_ATTEMPTS:-3}"
delay="${NEMOCLAW_NPM_RETRY_DELAY_SECONDS:-5}"
max_delay="${NEMOCLAW_NPM_RETRY_MAX_DELAY_SECONDS:-30}"

case "$attempts" in
  "" | *[!0-9]*) attempts=3 ;;
esac
case "$delay" in
  "" | *[!0-9]*) delay=5 ;;
esac
case "$max_delay" in
  "" | *[!0-9]*) max_delay=30 ;;
esac

[ "$attempts" -lt 1 ] && attempts=1
[ "$max_delay" -lt 1 ] && max_delay=1

export NPM_CONFIG_FETCH_RETRIES="${NPM_CONFIG_FETCH_RETRIES:-5}"
export NPM_CONFIG_FETCH_RETRY_MINTIMEOUT="${NPM_CONFIG_FETCH_RETRY_MINTIMEOUT:-20000}"
export NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT="${NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT:-120000}"
export NPM_CONFIG_FETCH_TIMEOUT="${NPM_CONFIG_FETCH_TIMEOUT:-300000}"

attempt=1
while :; do
  if "$@"; then
    exit 0
  else
    status=$?
  fi
  if [ "$attempt" -ge "$attempts" ]; then
    exit "$status"
  fi
  printf '[npm-retry] command failed with exit %s; retrying in %ss (%s/%s): %s\n' \
    "$status" "$delay" "$attempt" "$attempts" "$*" >&2
  sleep "$delay"
  attempt=$((attempt + 1))
  delay=$((delay * 2))
  [ "$delay" -gt "$max_delay" ] && delay="$max_delay"
done

#!/bin/sh
set -eu

PANEL_NAME_VALUE=${PANEL_NAME:-NEWS DESK CONTROL PANEL}
PANEL_DESC_VALUE=${PANEL_DESC:-Real-Time Ticker & Queue Control Management System}
TAB_TITLE_VALUE=${TAB_Title:-CONTROL PANEL}
FALLBACK_STREAM_VALUE=${FALLBACK_STREAM:-[SYSTEM] ALL STATIONS CLEAR // ROTATING TIMELINE STANDBY}

{
  printf 'window.WZN_CONFIG = '
  jq -n \
    --arg PANEL_NAME "$PANEL_NAME_VALUE" \
    --arg PANEL_DESC "$PANEL_DESC_VALUE" \
    --arg TAB_Title "$TAB_TITLE_VALUE" \
    --arg FALLBACK_STREAM "$FALLBACK_STREAM_VALUE" \
    '{
      PANEL_NAME: $PANEL_NAME,
      PANEL_DESC: $PANEL_DESC,
      TAB_Title: $TAB_Title,
      FALLBACK_STREAM: $FALLBACK_STREAM
    }'
  printf ';\n'
} > /usr/share/nginx/html/config.js

#!/bin/sh
set -eu

PANEL_NAME_VALUE=${PANEL_NAME:-NEWS DESK CONTROL PANEL}
PANEL_DESC_VALUE=${PANEL_DESC:-Real-Time Ticker & Queue Control Management System}
TAB_TITLE_VALUE=${TAB_Title:-CONTROL PANEL}
FALLBACK_STREAM_VALUE=${FALLBACK_STREAM:-[SYSTEM] ALL STATIONS CLEAR // ROTATING TIMELINE STANDBY}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

cat > /usr/share/nginx/html/config.js <<EOF
window.WZN_CONFIG = {
  PANEL_NAME: "$(json_escape "$PANEL_NAME_VALUE")",
  PANEL_DESC: "$(json_escape "$PANEL_DESC_VALUE")",
  TAB_Title: "$(json_escape "$TAB_TITLE_VALUE")",
  FALLBACK_STREAM: "$(json_escape "$FALLBACK_STREAM_VALUE")"
};
EOF

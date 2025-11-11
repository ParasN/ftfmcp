#!/usr/bin/env bash

set -euo pipefail

node mcp-server/src/index.js &
MCP_PID=$!

node backend/src/index.js &
API_PID=$!

cleanup() {
  kill "$MCP_PID" "$API_PID" 2>/dev/null || true
}

trap cleanup SIGINT SIGTERM

wait -n "$MCP_PID" "$API_PID"
cleanup
wait || true

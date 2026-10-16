#!/bin/bash

configure_test_tmpdir() {
  local selected
  echo ""
  echo "--- Test Temporary Storage (host only) ---"
  echo "  Use an absolute path on another disk, e.g. /data/tmp-test."
  echo "  Leave empty for the OS default; enter - to clear an existing setting."
  while true; do
    read -r -p "Test temporary directory [${TEST_TMPDIR:-OS default}]: " selected
    selected=${selected:-${TEST_TMPDIR:-}}
    if [ "$selected" = "-" ]; then selected=""; fi
    # Keep the generated value safe for both shell sourcing and dotenv parsing.
    if [ -n "$selected" ] && [[ ! "$selected" =~ ^/[[:alnum:]_./\ -]*$ ]]; then
      echo "[ERROR] Use an absolute path containing letters, numbers, spaces, /, ., _, or -."
      continue
    fi
    if [ -n "$selected" ] && ! mkdir -p -- "$selected"; then
      echo "[ERROR] Cannot create that directory. Choose a writable location."
      continue
    fi
    if [ -n "$selected" ] && { [ ! -w "$selected" ] || [ ! -x "$selected" ]; }; then
      echo "[ERROR] That directory is not writable/searchable."
      continue
    fi
    TEST_TMPDIR=$selected
    break
  done
}

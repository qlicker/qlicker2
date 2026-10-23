// Close a WebSocket without tripping the browser's "can't establish a
// connection" console error: calling close() on a still-CONNECTING socket
// aborts the handshake, which Firefox logs as a connection failure. Deferring
// the close until the handshake completes keeps teardown silent.
export function closeWebSocketQuietly(ws) {
  if (!ws) return;
  if (ws.readyState === WebSocket.CONNECTING) {
    ws.onopen = () => ws.close();
  } else if (ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
}

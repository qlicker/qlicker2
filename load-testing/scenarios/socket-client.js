// Adapt the existing scenario callbacks to k6's global-event-loop WebSocket API.
// Unlike k6/ws, it lets answer HTTP promises resolve while messages keep arriving.
// Dependencies are injected so close/error/timer behavior can be tested in Node.
export function createSocketConnector(WebSocket, timers) {
  return (url, configure) => new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timeouts = new Set();
    const intervals = new Set();
    let opened = false;
    let closed = false;
    let closing = false;
    let pending = 0;
    let failure = null;
    const clear = () => {
      timeouts.forEach((id) => timers.clearTimeout(id));
      intervals.forEach((id) => timers.clearInterval(id));
      timeouts.clear();
      intervals.clear();
    };
    const finish = () => {
      if (closed && pending === 0) {
        if (failure) reject(failure);
        else resolve({ status: opened ? 101 : 0 });
      }
    };
    const close = () => {
      closing = true;
      clear();
      ws.close();
    };
    const fail = (error) => {
      failure = error;
      closed = true;
      close();
      finish();
    };
    const call = (callback, value) => {
      try {
        const result = callback(value);
        if (result?.then) {
          pending += 1;
          Promise.resolve(result).then(() => { pending -= 1; finish(); }, (error) => {
            pending -= 1;
            fail(error);
          });
        }
      } catch (error) { fail(error); }
    };
    ws.addEventListener('open', () => { opened = true; });
    ws.addEventListener('close', () => { closed = true; clear(); finish(); });
    ws.addEventListener('error', close);
    const socket = {
      on(event, callback) {
        ws.addEventListener(event, (value) => call(callback,
          event === 'message' ? value.data : event === 'error' ? (value.error || 'WebSocket error') : value));
      },
      send: (data) => {
        if (!closing && !closed && ws.readyState === 1) ws.send(data);
      },
      close,
      setTimeout(callback, delay) {
        if (closing || closed) return;
        const id = timers.setTimeout(() => {
          timeouts.delete(id);
          if (!closing && !closed) call(callback);
        }, delay);
        timeouts.add(id);
      },
      setInterval(callback, delay) {
        if (closing || closed) return;
        intervals.add(timers.setInterval(() => { if (!closing && !closed) call(callback); }, delay));
      },
    };
    try { configure(socket); } catch (error) { fail(error); }
  });
}

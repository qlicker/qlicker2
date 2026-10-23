export function isRequestCanceled(error) {
  const code = String(error?.code || '');
  const name = String(error?.name || '');
  const message = String(error?.message || '');

  return code === 'ERR_CANCELED'
    || name === 'CanceledError'
    || name === 'AbortError'
    || message.toLowerCase().includes('canceled');
}

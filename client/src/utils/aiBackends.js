export function hasIncompleteAiBackend(backends = []) {
  return backends.some((backend) => !String(backend?.url || '').trim());
}

export function getAvailableAiModels(backends = []) {
  return backends.flatMap((backend) => (backend.models || [])
    .filter((model) => model.available !== false)
    .map((model) => ({ backend, model })));
}

export function getAiModelDisplayName(backend, model, override = '') {
  return String(override || model?.displayName || '').trim()
    || `${backend?.name || backend?.url || ''} — ${model?.name || model?.id || ''}`;
}

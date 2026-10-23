import { describe, expect, it } from 'vitest';
import { getAiModelDisplayName, getAvailableAiModels, hasIncompleteAiBackend } from './aiBackends';

describe('hasIncompleteAiBackend', () => {
  it('keeps a newly-added backend as a local draft until it has a URL', () => {
    expect(hasIncompleteAiBackend([{ id: 'new-backend', url: '' }])).toBe(true);
    expect(hasIncompleteAiBackend([{ id: 'configured-backend', url: 'http://localhost:11434' }])).toBe(false);
  });

  it('includes only enabled models in the course model choices', () => {
    expect(getAvailableAiModels([{
      id: 'backend-1',
      models: [{ id: 'available', available: true }, { id: 'disabled', available: false }],
    }])).toEqual([{
      backend: expect.objectContaining({ id: 'backend-1' }),
      model: expect.objectContaining({ id: 'available' }),
    }]);
  });

  it('uses a custom model name and falls back to the existing backend-model label', () => {
    const backend = { name: 'Backend' };
    const model = { id: 'model-1', name: 'Model 1' };

    expect(getAiModelDisplayName(backend, model)).toBe('Backend — Model 1');
    expect(getAiModelDisplayName(backend, { ...model, displayName: 'Admin name' })).toBe('Admin name');
    expect(getAiModelDisplayName(backend, { ...model, displayName: 'Admin name' }, 'Course name')).toBe('Course name');
  });
});

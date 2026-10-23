import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AiBackendManager from './AiBackendManager';
import apiClient from '../../api/client';
import i18n from '../../i18n';

vi.mock('../../api/client', () => ({ default: { post: vi.fn() } }));

describe('AiBackendManager', () => {
  beforeEach(() => vi.resetAllMocks());

  it('hides backend creation when the course cannot configure custom backends', () => {
    i18n.changeLanguage('en');
    render(<AiBackendManager backends={[]} canAddBackends={false} onChange={vi.fn()} onDefaultChange={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Add backend' })).not.toBeInTheDocument();
  });

  it('updates a model availability and sends the selected default to its parent', () => {
    const onChange = vi.fn();
    const onDefaultChange = vi.fn();
    render(<AiBackendManager
      backends={[{
        id: 'backend-1', url: 'http://ollama.test:11434', models: [{ id: 'model-1', name: 'Model 1', available: true }],
      }]}
      onChange={onChange}
      onDefaultChange={onDefaultChange}
    />);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Model 1' }));
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({
      models: [expect.objectContaining({ id: 'model-1', available: false })],
    })]);

    fireEvent.click(screen.getByRole('button', { name: 'Make default' }));
    expect(onDefaultChange).toHaveBeenCalledWith('backend-1', 'model-1');
  });

  it('defaults an administrator model name and allows a friendly override', () => {
    const onChange = vi.fn();
    render(<AiBackendManager
      backends={[{
        id: 'backend-1', name: 'Shared backend', url: 'http://ollama.test:11434',
        models: [{ id: 'model-1', name: 'Model 1', available: true }],
      }]}
      onChange={onChange}
      onDefaultChange={vi.fn()}
    />);

    const nameField = screen.getByLabelText('Model 1: User-facing model name');
    expect(nameField).toHaveValue('Shared backend — Model 1');
    fireEvent.change(nameField, { target: { value: 'Friendly model' } });

    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        models: [expect.objectContaining({ id: 'model-1', displayName: 'Friendly model' })],
      }),
    ]);
  });

  it('requests an immediate save when an API token field loses focus', () => {
    const onChange = vi.fn();
    const backends = [{ id: 'backend-1', url: 'http://ollama.test:11434', apiToken: 'secret', models: [] }];
    render(<AiBackendManager backends={backends} onChange={onChange} onDefaultChange={vi.fn()} />);

    fireEvent.blur(screen.getByLabelText('API token (optional)'));

    expect(onChange).toHaveBeenCalledWith(backends, { saveImmediately: true });
  });

  it('shows a saved API token as a persistent masked password value', () => {
    const onChange = vi.fn();
    render(<AiBackendManager
      backends={[{ id: 'backend-1', url: 'http://ollama.test:11434', apiToken: '', apiTokenSet: true, models: [] }]}
      onChange={onChange}
      onDefaultChange={vi.fn()}
    />);

    const tokenField = screen.getByLabelText('API token (optional)');
    expect(tokenField).toHaveValue('********');
    fireEvent.focus(tokenField);
    expect(tokenField).toHaveValue('');
    fireEvent.change(tokenField, { target: { value: 'replacement-token' } });
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'backend-1', apiToken: 'replacement-token', apiTokenSet: true }),
    ], { deferSave: true });
  });

  it('queries the backend when showing available models', async () => {
    const onChange = vi.fn();
    apiClient.post.mockResolvedValue({ data: { models: [{ id: 'model-2', name: 'Model 2' }] } });
    render(<AiBackendManager
      backends={[{ id: 'backend-1', type: 'ollama', url: 'http://ollama.test:11434', apiToken: '', apiTokenSet: true, models: [] }]}
      courseId="course-1"
      onChange={onChange}
      onDefaultChange={vi.fn()}
      onModelPoliciesChange={vi.fn()}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'Show available models' }));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/ai/discover-models', {
      backendId: 'backend-1',
      url: 'http://ollama.test:11434',
      type: 'ollama',
      apiToken: '',
      courseId: 'course-1',
    }));
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ models: [{ id: 'model-2', name: 'Model 2', displayName: '', available: true }] }),
    ]);
  });

  it('shows all administrator models and controls professor and student access separately', () => {
    const onModelPoliciesChange = vi.fn();
    render(<AiBackendManager
      backends={[{
        id: 'backend-1',
        name: 'Shared backend',
        url: 'http://ollama.test:11434',
        models: [
          { id: 'model-1', name: 'Model 1', available: true },
          { id: 'model-2', name: 'Model 2', available: true },
        ],
      }]}
      courseId="course-1"
      readOnly
      canAddBackends={false}
      onChange={vi.fn()}
      defaultBackendId="backend-1"
      defaultModelId="model-1"
      modelPolicies={[{ backendId: 'backend-1', modelId: 'model-1', studentAvailable: false }]}
      onModelPoliciesChange={onModelPoliciesChange}
    />);

    expect(screen.getByRole('checkbox', { name: 'Shared backend — Model 1: Available to professors in this course' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Shared backend — Model 2: Available to professors in this course' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Shared backend — Model 1: Available to students' }));
    expect(onModelPoliciesChange).toHaveBeenLastCalledWith([
      { backendId: 'backend-1', modelId: 'model-1', studentAvailable: true },
    ]);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Shared backend — Model 2: Available to professors in this course' }));
    expect(onModelPoliciesChange).toHaveBeenLastCalledWith([
      { backendId: 'backend-1', modelId: 'model-1', studentAvailable: false },
      { backendId: 'backend-1', modelId: 'model-2', studentAvailable: false },
    ]);
  });

  it('inherits the administrator model name until a professor overrides it', () => {
    const onModelPoliciesChange = vi.fn();
    render(<AiBackendManager
      backends={[{
        id: 'backend-1', name: 'Shared backend', url: 'http://ollama.test:11434',
        models: [{ id: 'model-1', name: 'Model 1', displayName: 'Admin-friendly model', available: true }],
      }]}
      courseId="course-1"
      readOnly
      canAddBackends={false}
      onChange={vi.fn()}
      modelPolicies={[{ backendId: 'backend-1', modelId: 'model-1', studentAvailable: true }]}
      onModelPoliciesChange={onModelPoliciesChange}
    />);

    const nameField = screen.getByLabelText('Model 1: User-facing model name');
    expect(nameField).toHaveValue('Admin-friendly model');
    fireEvent.change(nameField, { target: { value: 'Course-friendly model' } });

    expect(onModelPoliciesChange).toHaveBeenCalledWith([
      {
        backendId: 'backend-1',
        modelId: 'model-1',
        displayName: 'Course-friendly model',
        studentAvailable: true,
      },
    ]);
  });
});

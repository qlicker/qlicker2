import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import apiClient from '../../api/client';
import i18n from '../../i18n';
import AiModelSelect from './AiModelSelect';

vi.mock('../../api/client', () => ({ default: { get: vi.fn() } }));

const config = {
  approvedModels: [
    { backendId: 'backend-1', backendName: 'Backend', modelId: 'model-1', modelName: 'Model 1' },
    { backendId: 'backend-1', backendName: 'Backend', modelId: 'model-2', modelName: 'Model 2' },
  ],
  defaultBackendId: 'backend-1',
  defaultModelId: 'model-1',
};

describe('AiModelSelect persistence', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
    i18n.changeLanguage('en');
    apiClient.get.mockResolvedValue({ data: config });
  });

  it('restores the last valid model separately for each task', async () => {
    localStorage.setItem('qlicker.ai.model.instructor.course-1.grading', 'backend-1::model-2');
    const onChange = vi.fn();

    render(<AiModelSelect courseId="course-1" task="grading" value="" onChange={onChange} />);

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('backend-1::model-2'));
    expect(localStorage.getItem('qlicker.ai.model.instructor.course-1.response-summary')).toBeNull();
  });

  it('stores a selection under its course, audience, and task key', async () => {
    apiClient.get.mockResolvedValue({ data: {
      ...config,
      approvedModels: [
        config.approvedModels[0],
        { ...config.approvedModels[1], displayName: 'Friendly Model 2' },
      ],
    } });
    const onChange = vi.fn();
    render(<AiModelSelect courseId="course-1" task="response-summary" value="backend-1::model-1" onChange={onChange} />);

    const select = await screen.findByRole('combobox', { name: 'Model for this task' });
    fireEvent.mouseDown(select);
    fireEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: 'Friendly Model 2' }));

    expect(onChange).toHaveBeenCalledWith('backend-1::model-2');
    expect(localStorage.getItem('qlicker.ai.model.instructor.course-1.response-summary')).toBe('backend-1::model-2');
  });
});

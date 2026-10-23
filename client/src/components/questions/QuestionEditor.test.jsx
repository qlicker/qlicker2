import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import QuestionEditor from './QuestionEditor';

const { tMock } = vi.hoisted(() => ({
  tMock: vi.fn((key, options) => options?.defaultValue ?? key),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tMock }),
}));

vi.mock('./RichTextEditor', () => ({
  default: ({ label, placeholder, value = '', onChange }) => (
    <textarea
      aria-label={label || placeholder || 'Rich text editor'}
      placeholder={placeholder || ''}
      value={value}
      onChange={(event) => onChange?.({ html: event.target.value })}
    />
  ),
}));

vi.mock('../common/AutoSaveStatus', () => ({
  default: () => <div>Autosave status</div>,
}));

describe('QuestionEditor', () => {
  it('disables tags and keeps the course-tag guidance inside the tag field when no topics exist', () => {
    render(
      <QuestionEditor
        open
        inline
        initial={null}
        onAutoSave={vi.fn()}
        allowCustomTags={false}
        showVisibilityControls={false}
        showCourseTagSettingsHint
        tagSuggestions={[]}
      />
    );

    expect(screen.getByLabelText('Tags')).toBeDisabled();
    expect(screen.getByPlaceholderText('No tags defined in course settings yet')).toBeInTheDocument();
    expect(screen.queryByText('Only course-related topics can be added as question tags. Add course topics in Course Settings to enable tagging.')).not.toBeInTheDocument();
  });

  it('uses in-editor guidance instead of a separate Question Text label', () => {
    render(
      <QuestionEditor
        open
        inline
        initial={null}
        onAutoSave={vi.fn()}
        showVisibilityControls={false}
      />
    );

    expect(screen.queryByText('questions.editor.questionText')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Write the question here/ })).toBeInTheDocument();
  });

  it('allows removing existing legacy tags when no course topics exist', async () => {
    vi.useFakeTimers();
    const onAutoSave = vi.fn().mockResolvedValue({ _id: 'question-legacy' });

    render(
      <QuestionEditor
        open
        inline
        initial={{
          _id: 'question-legacy',
          type: 2,
          content: '<p>Legacy tag question</p>',
          plainText: 'Legacy tag question',
          tags: [{ value: 'legacy-topic', label: 'legacy-topic' }],
          sessionOptions: { points: 1 },
        }}
        onAutoSave={onAutoSave}
        allowCustomTags={false}
        showVisibilityControls={false}
        showCourseTagSettingsHint
        tagSuggestions={[]}
      />
    );

    expect(screen.getByLabelText('Tags')).not.toBeDisabled();
    expect(screen.getByText('legacy-topic')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    fireEvent.keyDown(screen.getByLabelText('Tags'), { key: 'Backspace', code: 'Backspace' });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });

    expect(onAutoSave).toHaveBeenCalledWith(expect.objectContaining({
      tags: [],
    }), 'question-legacy');
    expect(screen.getByLabelText('Tags')).toBeDisabled();

    vi.useRealTimers();
  });

  it('keeps visibility settings locked when the visibility controls are hidden', async () => {
    vi.useFakeTimers();
    const onAutoSave = vi.fn().mockResolvedValue({ _id: 'question-1' });

    render(
      <QuestionEditor
        open
        inline
        initial={{
          _id: 'question-1',
          type: 2,
          content: '<p>Question body</p>',
          options: [
            { content: '<p>Option 1</p>', correct: true },
            { content: '<p>Option 2</p>', correct: false },
          ],
          sessionOptions: { points: 1 },
          public: true,
          publicOnQlicker: true,
          publicOnQlickerForStudents: true,
        }}
        onAutoSave={onAutoSave}
        showVisibilityControls={false}
      />
    );

    expect(screen.queryByLabelText('Visible to students in this course')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Visible to any prof on Qlicker')).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });

    expect(onAutoSave).toHaveBeenCalledWith(expect.objectContaining({
      public: true,
      publicOnQlicker: true,
      publicOnQlickerForStudents: true,
      sessionOptions: { points: 2 },
    }), 'question-1');

    vi.useRealTimers();
  });

  it('keeps points editable for response-backed questions and persists zero points', async () => {
    vi.useFakeTimers();
    const onAutoSave = vi.fn().mockResolvedValue({ _id: 'question-with-responses' });

    render(
      <QuestionEditor
        open
        inline
        initial={{
          _id: 'question-with-responses',
          type: 0,
          content: '<p>Already answered</p>',
          options: [
            { content: '<p>Yes</p>', correct: true },
            { content: '<p>No</p>', correct: false },
          ],
          sessionOptions: { points: 1 },
        }}
        onAutoSave={onAutoSave}
        disableTypeSelection
        disableOptionCountChanges
        showVisibilityControls={false}
      />
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const pointsInput = screen.getByRole('spinbutton', { name: 'questions.editor.points' });
    expect(pointsInput).toBeEnabled();
    fireEvent.change(pointsInput, { target: { value: '0' } });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });

    expect(onAutoSave).toHaveBeenCalledWith(expect.objectContaining({
      sessionOptions: { points: 0 },
    }), 'question-with-responses');

    vi.useRealTimers();
  });

  it('persists a new slide on close when the content is structural HTML only', async () => {
    vi.useFakeTimers();
    const onAutoSave = vi.fn().mockResolvedValue({ _id: 'slide-1' });
    const onClose = vi.fn();

    render(
      <QuestionEditor
        open
        inline
        initial={{
          type: 6,
          content: '',
          plainText: '',
          options: [],
          sessionOptions: { points: 0 },
        }}
        onAutoSave={onAutoSave}
        onClose={onClose}
        showVisibilityControls={false}
      />
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    fireEvent.change(screen.getByRole('textbox', { name: /Write the slide content here/ }), {
      target: { value: '<table><tbody><tr><td></td></tr></tbody></table>' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
      await Promise.resolve();
    });

    expect(onAutoSave).toHaveBeenCalledWith(expect.objectContaining({
      type: 6,
      content: '<table><tbody><tr><td></td></tr></tbody></table>',
      plainText: '',
      sessionOptions: { points: 0 },
    }), null);
    expect(onClose).toHaveBeenCalledWith({ persistedQuestionId: 'slide-1' });

    vi.useRealTimers();
  });
});

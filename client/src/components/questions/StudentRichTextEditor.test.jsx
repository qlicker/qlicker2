import {
  act, fireEvent, render, screen,
} from '@testing-library/react';
import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import StudentRichTextEditor from './StudentRichTextEditor';
import i18n from '../../i18n';

vi.mock('./RichTextEditor', () => ({
  default: ({ value, onChange, onBlur, onKeyDown, minHeight, ariaLabel }) => (
    <textarea
      aria-label={ariaLabel}
      data-min-height={minHeight}
      defaultValue={value}
      onChange={(event) => onChange({ html: event.target.value, plainText: event.target.value })}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    />
  ),
}));

describe('StudentRichTextEditor', () => {
  beforeEach(() => {
    i18n.changeLanguage('en');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces draft updates while typing and delivers only the newest value', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();

    render(
      <StudentRichTextEditor
        value=""
        onChange={onChange}
        onChangeDebounceMs={200}
        ariaLabel="Chat message"
        showMathHint={false}
      />
    );

    const editor = screen.getByLabelText('Chat message');
    fireEvent.change(editor, { target: { value: 'First' } });
    act(() => vi.advanceTimersByTime(100));
    fireEvent.change(editor, { target: { value: 'Latest' } });
    act(() => vi.advanceTimersByTime(199));
    expect(onChange).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ html: 'Latest', plainText: 'Latest' });
  });

  it('flushes a debounced draft before an Enter-to-submit handler runs', () => {
    const onChange = vi.fn();
    const onKeyDown = vi.fn(() => true);

    render(
      <StudentRichTextEditor
        value=""
        onChange={onChange}
        onChangeDebounceMs={120}
        onKeyDown={onKeyDown}
        ariaLabel="Chat message"
        showMathHint={false}
      />
    );

    const editor = screen.getByLabelText('Chat message');
    fireEvent.change(editor, { target: { value: '<p>Latest text</p>' } });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.keyDown(editor, { key: 'Enter' });

    const latestDraft = { html: '<p>Latest text</p>', plainText: '<p>Latest text</p>' };
    expect(onChange).toHaveBeenCalledWith(latestDraft);
    expect(onKeyDown).toHaveBeenCalledWith(expect.objectContaining({ key: 'Enter' }), latestDraft);
    expect(screen.getByLabelText('Chat message')).toHaveValue('');
  });

  it('does not let a delayed parent acknowledgement overwrite newer typing', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const { rerender } = render(
      <StudentRichTextEditor
        value=""
        onChange={onChange}
        onChangeDebounceMs={200}
        ariaLabel="Chat message"
        showMathHint={false}
      />
    );

    const editor = screen.getByLabelText('Chat message');
    fireEvent.change(editor, { target: { value: 'Text before pause' } });
    act(() => vi.advanceTimersByTime(200));
    fireEvent.change(editor, { target: { value: 'Text before pause and after' } });

    rerender(
      <StudentRichTextEditor
        value="Text before pause"
        onChange={onChange}
        onChangeDebounceMs={200}
        ariaLabel="Chat message"
        showMathHint={false}
      />
    );

    expect(editor).toHaveValue('Text before pause and after');
  });

  it('still applies genuine external clears', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <StudentRichTextEditor
        value="Initial draft"
        onChange={onChange}
        ariaLabel="Chat message"
        showMathHint={false}
      />
    );

    expect(screen.getByLabelText('Chat message')).toHaveValue('Initial draft');
    rerender(
      <StudentRichTextEditor
        value=""
        onChange={onChange}
        ariaLabel="Chat message"
        showMathHint={false}
      />
    );
    expect(screen.getByLabelText('Chat message')).toHaveValue('');
  });

  it('passes the requested editor height through', () => {
    render(
      <StudentRichTextEditor
        value=""
        onChange={() => {}}
        minHeight={110}
        ariaLabel="Tall chat message"
        showMathHint={false}
      />
    );

    expect(screen.getByLabelText('Tall chat message')).toHaveAttribute('data-min-height', '110');
  });
});

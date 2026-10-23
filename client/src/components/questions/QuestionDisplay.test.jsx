import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import QuestionDisplay from './QuestionDisplay';
import { QUESTION_TYPES } from './constants';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, options = {}) => {
      if (typeof options.defaultValue === 'string') return options.defaultValue;
      if (key === 'questions.display.points' || key === 'questions.display.pointsPlural') {
        return String(options.points ?? '');
      }
      if (key === 'questions.display.option') {
        return `Option ${options.index || ''}`.trim();
      }
      if (key === 'questions.display.correct') {
        return `Correct: ${options.value ?? ''}`;
      }
      if (key === 'questions.display.tolerance') {
        return `Tolerance: ${options.value ?? ''}`;
      }
      return key;
    },
  }),
}));

function ParentRerenderHarness({ question }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div>
      <button type="button" onClick={() => setExpanded((prev) => !prev)}>
        {expanded ? 'Collapse unrelated section' : 'Expand unrelated section'}
      </button>
      <div aria-label="unrelated-state">{expanded ? 'expanded' : 'collapsed'}</div>
      <QuestionDisplay question={question} />
    </div>
  );
}

describe('QuestionDisplay video stability', () => {
  it('keeps the same iframe node when a parent rerenders with the same question object', () => {
    const question = {
      _id: 'question-1',
      type: QUESTION_TYPES.SHORT_ANSWER,
      content: '<p>Watch this:</p><iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ?start=42" width="560" height="315"></iframe>',
      plainText: 'Watch this',
      options: [],
      sessionOptions: { points: 1 },
    };

    render(<ParentRerenderHarness question={question} />);

    const firstIframe = document.querySelector('iframe[src*="youtube.com/embed/dQw4w9WgXcQ"]');
    expect(firstIframe).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Expand unrelated section' }));
    const secondIframe = document.querySelector('iframe[src*="youtube.com/embed/dQw4w9WgXcQ"]');
    expect(secondIframe).toBe(firstIframe);

    fireEvent.click(screen.getByRole('button', { name: 'Collapse unrelated section' }));
    const thirdIframe = document.querySelector('iframe[src*="youtube.com/embed/dQw4w9WgXcQ"]');
    expect(thirdIframe).toBe(firstIframe);
  });
});

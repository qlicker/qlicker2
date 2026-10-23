import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AnonymousResponsesPanel from './AnonymousResponsesPanel';
import apiClient from '../../api/client';
import i18n from '../../i18n';

vi.mock('../../api/client', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));

const questions = [
  { _id: 'mc', type: 0, content: '<p>Choose a planet</p>', solution: '<p>Earth supports life.</p>',
    options: [{ content: '<p>Earth</p>', correct: true }, { content: '<p>Mars</p>', correct: false }] },
  { _id: 'tf', type: 1, content: '<p>True or false?</p>',
    options: [{ content: '<p>True</p>', correct: true }, { content: '<p>False</p>', correct: false }] },
  { _id: 'ms', type: 3, content: '<p>Select the primes</p>',
    options: [{ content: '<p>Two</p>', correct: true }, { content: '<p>Three</p>', correct: true }] },
  { _id: 'nu', type: 4, content: '<p>Give a number</p>', correctNumerical: 42, toleranceNumerical: 0.1 },
  { _id: 'sa', type: 2, content: '<p>Explain your choice</p>', solution: '<p>Example explanation.</p>' },
];

describe('Anonymous response question review', () => {
  beforeEach(() => { vi.clearAllMocks(); i18n.changeLanguage('en'); });

  it.each(questions)('shows the actual withheld count and permits reviewing an eligible attempt for $type', (question) => {
    render(<AnonymousResponsesPanel
      questions={[{ ...question, anonymousResponseAttempts: [
        { attempt: 1, respondentCount: 4, responsesWithheld: false, minimumRespondents: 4 },
        { attempt: 2, respondentCount: 3, responsesWithheld: true, minimumRespondents: 4 },
      ] }]}
      studentResults={Array.from({ length: 4 }, (_, index) => ({
        studentId: `respondent-${index + 1}`, firstname: `Respondent ${index + 1}`,
        questionResults: [{ questionId: question._id, responses: [{ attempt: 1, answer: '0' }] }],
      }))}
    />);
    expect(screen.getByText('3 responses')).toBeInTheDocument();
    expect(screen.getByText('Answers hidden — fewer than 4 respondents.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText('No responses yet')).not.toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Attempt' }));
    fireEvent.click(screen.getByRole('option', { name: 'Attempt 1/2' }));
    expect(screen.getByText('4 responses')).toBeInTheDocument();
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(5);
  });

  it('uses the grading navigator and full preview for every question type without grading requests', () => {
    render(<AnonymousResponsesPanel questions={questions} studentResults={[]} />);
    expect(screen.getAllByText('Earth').length).toBeGreaterThan(0);
    expect(screen.getByText('Mars')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show Solution' }));
    expect(screen.getByText('Earth supports life.')).toBeInTheDocument();
    const navigator = screen.getByRole('navigation', { name: 'Question navigator' });
    fireEvent.click(within(navigator).getByRole('button', { name: 'Q2' }));
    expect(screen.getAllByText('True').length).toBeGreaterThan(0);
    expect(screen.getByText('False')).toBeInTheDocument();
    expect(screen.queryByText('Earth supports life.')).not.toBeInTheDocument();
    fireEvent.click(within(navigator).getByRole('button', { name: 'Q3' }));
    expect(screen.getAllByText('Two').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Three').length).toBeGreaterThan(0);
    fireEvent.click(within(navigator).getByRole('button', { name: 'Q4' }));
    expect(screen.getByText(/42.*0.1/)).toBeInTheDocument();
    fireEvent.click(within(navigator).getByRole('button', { name: 'Q5' }));
    expect(screen.getByText('Explain your choice')).toBeInTheDocument();
    expect(screen.queryByText('Manual grading required.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show Solution' }));
    expect(screen.getByText('Example explanation.')).toBeInTheDocument();
    fireEvent.click(within(navigator).getByRole('button', { name: 'Q1' }));
    expect(screen.queryByText('Earth supports life.')).not.toBeInTheDocument();
    expect(within(navigator).getByRole('button', { name: 'Q1' })).toHaveAttribute('aria-current', 'step');
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(apiClient.get).not.toHaveBeenCalled();
    expect(apiClient.post).not.toHaveBeenCalled();
    expect(apiClient.patch).not.toHaveBeenCalled();
  });
});

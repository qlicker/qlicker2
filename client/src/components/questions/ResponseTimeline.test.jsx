import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import i18n from '../../i18n';
import ResponseTimeline from './ResponseTimeline';
import { collectResponseTimeline } from '../../utils/responseTimeline';

const data = collectResponseTimeline([
  { submittedAt: '2026-10-02T19:00:00Z' },
  { submittedAt: '2026-10-02T19:00:00Z' },
  { createdAt: '2026-10-02T19:02:00Z' },
  { createdAt: '2026-10-02T19:04:00Z' },
  {},
]);
const props = { title: 'Session response timeline', data };

function expandTimeline() {
  fireEvent.click(screen.getByRole('button', { name: props.title }));
}

function pointer(svg, x, type = 'mouse') {
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 900, height: 250 });
  const event = new Event('pointerdown', { bubbles: true });
  Object.assign(event, { clientX: x, clientY: 100, pointerType: type });
  fireEvent(svg, event);
}

describe('ResponseTimeline', () => {
  beforeEach(() => i18n.changeLanguage('en'));

  it('supports keyboard, pointer and touch inspection, including empty intervals', () => {
    render(<ResponseTimeline {...props} />);
    expect(screen.getByRole('button', { name: props.title })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expandTimeline();
    expect(screen.getByText(/Responses plotted: 4/)).toBeVisible();
    expect(screen.getByText(/without a usable timestamp: 1/)).toBeVisible();
    const chart = screen.getByRole('img', { name: props.title });
    fireEvent.focus(chart);
    expect(screen.getByRole('status')).toHaveTextContent('Responses: 2');
    fireEvent.keyDown(chart, { key: 'ArrowRight' });
    expect(screen.getByRole('status')).toHaveTextContent('Responses: 0');
    fireEvent.keyDown(chart, { key: 'End' });
    expect(screen.getByRole('status')).toHaveTextContent('Responses: 1');
    fireEvent.keyDown(chart, { key: 'Escape' });
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    pointer(chart, 56);
    expect(screen.getByRole('status')).toHaveTextContent('Responses: 2');
    pointer(chart, 864, 'touch');
    fireEvent.blur(chart);
    expect(screen.getByRole('status')).toHaveTextContent('Responses: 1');
  });

  it('marks scheduled quiz dates without restricting responses to the schedule', () => {
    render(<ResponseTimeline {...props} quiz quizStart="2026-10-02T19:01:00Z" quizEnd="2026-10-02T19:03:00Z" />);
    expandTimeline();
    expect(screen.getByText(/last saved time/)).toBeVisible();
    expect(screen.getByText(/Responses plotted: 4/)).toBeVisible();
    const chart = screen.getByRole('img');
    expect(chart.querySelectorAll('line[stroke-dasharray]')).toHaveLength(2);
    expect(screen.getByText(/^Scheduled opening:/, { selector: 'div' })).toBeVisible();
    expect(screen.getByText(/^Scheduled closing:/, { selector: 'div' })).toBeVisible();
  });

  it('lists dates outside its own response range and clears stale readouts when detail changes', () => {
    render(<ResponseTimeline {...props} quiz quizStart="2026-10-02T18:00:00Z" quizEnd="2026-10-02T21:00:00Z" />);
    expandTimeline();
    expect(screen.getAllByText(/outside response range/)).toHaveLength(2);
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    fireEvent.focus(screen.getByRole('img'));
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Detail' }));
    fireEvent.click(screen.getByRole('option', { name: 'Fine' }));
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(screen.getAllByText(/outside response range/)).toHaveLength(2);
    expect(screen.getByText(/Responses plotted: 4/)).toBeVisible();
  });

  it('handles unavailable dates and creates charts only when expanded', () => {
    render(<ResponseTimeline title="Question timeline" data={collectResponseTimeline([{}, { createdAt: 'invalid' }])} />);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Question timeline' }));
    expect(within(screen.getByRole('region')).getByText('No response timestamps are available.')).toBeVisible();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});

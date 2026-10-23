import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import MonitoringLineChart from './MonitoringLineChart';
import { formatDisplayDateTime } from '../../utils/date';

const points = [
  { timestamp: '2026-09-10T10:00:00Z', cpu: 10, memory: 60 },
  { timestamp: '2026-09-10T10:05:00Z', cpu: null, memory: 62 },
  { timestamp: '2026-09-10T10:10:00Z', cpu: 30, memory: 64 },
];
const props = {
  title: 'Resources', description: 'Host history', emptyLabel: 'No history', points,
  yMaximum: 100, valueFormatter: (value) => `${value}%`,
  series: [{ key: 'cpu', label: 'CPU', color: '#1976d2' }, { key: 'memory', label: 'Memory', color: '#d32f2f' }],
};

function pointer(svg, x, y = 100, type = 'pointermove', pointerType = 'mouse') {
  // Exercise scaled/offset client coordinates, including a scrolled SVG.
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: -100, top: 50, width: 450, height: 122.5 });
  const event = new MouseEvent(type, { bubbles: true, clientX: -100 + x / 2, clientY: 50 + y / 2 });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  fireEvent(svg, event);
}

describe('MonitoringLineChart inspection', () => {
  it('shows nearest bucket coordinates on hover, with gaps rather than interpolated or zero values', () => {
    render(<MonitoringLineChart {...props} />);
    const svg = screen.getByRole('img');
    pointer(svg, 64 + 806 * 0.48);
    const readout = screen.getByRole('status');
    expect(readout).toHaveTextContent(formatDisplayDateTime(points[1].timestamp));
    expect(readout).toHaveTextContent('CPU: No reading');
    expect(readout).toHaveTextContent('Memory: 62%');
    expect(readout).toHaveAttribute('aria-live', 'off');
    // The CPU path must remain split across its missing bucket.
    expect(svg.querySelector('path').getAttribute('d').match(/M/g)).toHaveLength(2);
    expect(svg.querySelector('path').getAttribute('d')).not.toContain('L');
    pointer(svg, 64 + 806 * 0.9);
    expect(readout).toHaveTextContent('CPU: 30%');
    pointer(svg, 20);
    expect(readout).toBeEmptyDOMElement();
  });

  it('supports keyboard navigation, boundary clamping, dismissal and blur', () => {
    render(<MonitoringLineChart {...props} />);
    const svg = screen.getByRole('img');
    const readout = screen.getByRole('status');
    fireEvent.focus(svg);
    expect(readout).toHaveTextContent('CPU: 30%');
    expect(readout).toHaveAttribute('aria-live', 'polite');
    fireEvent.keyDown(svg, { key: 'Home' });
    expect(readout).toHaveTextContent('CPU: 10%');
    fireEvent.keyDown(svg, { key: 'ArrowLeft' });
    expect(readout).toHaveTextContent('CPU: 10%');
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(readout).toHaveTextContent('CPU: No reading');
    fireEvent.keyDown(svg, { key: 'End' });
    expect(readout).toHaveTextContent('CPU: 30%');
    fireEvent.keyDown(svg, { key: 'Escape' });
    expect(readout).toBeEmptyDOMElement();
    fireEvent.keyDown(svg, { key: 'ArrowLeft' });
    expect(readout).toHaveTextContent('CPU: No reading');
    fireEvent.blur(svg);
    expect(readout).toBeEmptyDOMElement();
  });

  it('supports touch inspection and Escape without chart focus', () => {
    render(<MonitoringLineChart {...props} />);
    const svg = screen.getByRole('img');
    pointer(svg, 64, 100, 'pointerup', 'touch');
    fireEvent.focus(svg);
    fireEvent.blur(svg);
    expect(screen.getByRole('status')).toHaveTextContent('CPU: 10%');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    pointer(svg, 64, 100, 'pointerup', 'touch');
    fireEvent.pointerDown(document.body);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('clears obsolete coordinates on data replacement and supports a single data point', () => {
    const { rerender } = render(<MonitoringLineChart {...props} />);
    fireEvent.focus(screen.getByRole('img'));
    const replacement = [points[0]];
    rerender(<MonitoringLineChart {...props} points={replacement} />);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    pointer(screen.getByRole('img'), 400);
    expect(screen.getByRole('status')).toHaveTextContent('CPU: 10%');
    expect(screen.getByRole('img').querySelector('circle')).toHaveAttribute('r', '3');
    rerender(<MonitoringLineChart {...props} points={[]} />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('No history')).toBeVisible();
  });

  it('keeps the correct units and does not mix readouts between charts', () => {
    render(<><MonitoringLineChart {...props} /><MonitoringLineChart {...props} title="Network"
      points={[{ timestamp: points[0].timestamp, rx: 2 }]}
      series={[{ key: 'rx', label: 'Received', color: '#1976d2' }]}
      valueFormatter={(value) => `${value} KiB/s`} /></>);
    pointer(screen.getByRole('img', { name: /Network/ }), 400);
    const readouts = screen.getAllByRole('status');
    expect(readouts[0]).toBeEmptyDOMElement();
    expect(within(readouts[1]).getByText('Received: 2 KiB/s')).toBeVisible();
  });
});

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import WordCloudPanel from './WordCloudPanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key) => {
      const map = {
        'wordCloud.generate': 'Generate Word Cloud',
        'wordCloud.refresh': 'Refresh Word Cloud',
        'wordCloud.hide': 'Hide Word Cloud',
        'wordCloud.show': 'Show Word Cloud',
        'wordCloud.hidden': 'Word cloud is hidden.',
        'wordCloud.noData': 'Not enough word data to display.',
        'wordCloud.ariaLabel': 'Word cloud visualization',
        'common.loading': 'Loading…',
      };
      return map[key] ?? key;
    },
  }),
}));

// Mock WordCloudDisplay to avoid d3-cloud dynamic import in tests
vi.mock('./WordCloudDisplay', () => ({
  default: ({ wordFrequencies }) => (
    <div data-testid="word-cloud-display">
      {wordFrequencies.map((w) => w.text).join(', ')}
    </div>
  ),
}));

describe('WordCloudPanel', () => {
  const sampleCloudData = {
    wordFrequencies: [
      { text: 'hello', count: 5 },
      { text: 'world', count: 3 },
    ],
    visible: true,
    generatedAt: new Date().toISOString(),
  };

  it('shows generate button when no word cloud exists (showControls)', () => {
    render(
      <WordCloudPanel
        wordCloudData={null}
        onGenerate={vi.fn()}
        showControls
      />
    );
    expect(screen.getByText('Generate Word Cloud')).toBeInTheDocument();
  });

  it('shows word cloud and refresh/hide buttons when data exists (showControls)', () => {
    render(
      <WordCloudPanel
        wordCloudData={sampleCloudData}
        onGenerate={vi.fn()}
        onToggleVisible={vi.fn()}
        showControls
      />
    );
    expect(screen.getByTestId('word-cloud-display')).toBeInTheDocument();
    expect(screen.getByText('Refresh Word Cloud')).toBeInTheDocument();
    expect(screen.getByText('Hide Word Cloud')).toBeInTheDocument();
  });

  it('shows "hidden" message when visible=false (showControls)', () => {
    render(
      <WordCloudPanel
        wordCloudData={{ ...sampleCloudData, visible: false }}
        onGenerate={vi.fn()}
        onToggleVisible={vi.fn()}
        showControls
      />
    );
    expect(screen.getByText('Word cloud is hidden.')).toBeInTheDocument();
    expect(screen.getByText('Show Word Cloud')).toBeInTheDocument();
  });

  it('calls onGenerate when generate button is clicked', async () => {
    const onGenerate = vi.fn(() => Promise.resolve());
    render(
      <WordCloudPanel
        wordCloudData={null}
        onGenerate={onGenerate}
        showControls
      />
    );
    fireEvent.click(screen.getByText('Generate Word Cloud'));
    await waitFor(() => expect(onGenerate).toHaveBeenCalledOnce());
  });

  it('renders nothing for student view when no cloud data exists', () => {
    const { container } = render(
      <WordCloudPanel wordCloudData={null} />
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing for student view when cloud is hidden', () => {
    const { container } = render(
      <WordCloudPanel wordCloudData={{ ...sampleCloudData, visible: false }} />
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders word cloud for student view when cloud is visible', () => {
    render(
      <WordCloudPanel wordCloudData={sampleCloudData} />
    );
    expect(screen.getByTestId('word-cloud-display')).toBeInTheDocument();
  });
});

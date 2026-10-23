import { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import { Box, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';

/* ---------- colour palette for word cloud text ---------- */
const PALETTE = [
  '#1976d2', '#388e3c', '#d32f2f', '#7b1fa2', '#f57c00',
  '#0288d1', '#c2185b', '#00796b', '#5d4037', '#455a64',
];

/**
 * WordCloudDisplay renders an SVG word cloud from a list of
 * `{ text, count }` entries using d3-cloud for layout computation.
 *
 * Props:
 *   wordFrequencies - { text: string, count: number }[]
 *   width           - pixel width of the SVG (default 600)
 *   height          - pixel height of the SVG (default 300)
 */
export default function WordCloudDisplay({ wordFrequencies = [], width = 600, height = 300 }) {
  const { t } = useTranslation();
  const svgRef = useRef(null);
  const [words, setWords] = useState([]);
  const [layoutReady, setLayoutReady] = useState(false);

  // Determine font-size scale from data
  const entries = useMemo(() => {
    if (!wordFrequencies || wordFrequencies.length === 0) return [];
    return wordFrequencies.filter((w) => w && w.text && w.count > 0);
  }, [wordFrequencies]);

  const runLayout = useCallback(async () => {
    if (entries.length === 0) {
      setWords([]);
      setLayoutReady(true);
      return;
    }

    const maxCount = Math.max(...entries.map((w) => w.count));
    const minCount = Math.min(...entries.map((w) => w.count));
    const range = maxCount - minCount || 1;

    const minFont = 12;
    const maxFont = Math.min(60, height / 3);

    const sized = entries.map((w) => ({
      text: w.text,
      size: minFont + ((w.count - minCount) / range) * (maxFont - minFont),
      count: w.count,
    }));

    try {
      const cloudModule = await import('d3-cloud');
      const cloud = cloudModule.default || cloudModule;

      cloud()
        .size([width, height])
        .words(sized.map((d) => ({ ...d })))
        .padding(3)
        .rotate(() => 0) // all horizontal for readability
        .font('Arial, Helvetica, sans-serif')
        .fontSize((d) => d.size)
        .on('end', (placed) => {
          setWords(placed);
          setLayoutReady(true);
        })
        .start();
    } catch {
      // Fallback: just display words without layout
      setWords(sized.map((d, i) => ({
        ...d,
        x: (i % 5) * (width / 5) - width / 2 + 40,
        y: Math.floor(i / 5) * 30 - height / 2 + 30,
        rotate: 0,
      })));
      setLayoutReady(true);
    }
  }, [entries, width, height]);

  useEffect(() => {
    setLayoutReady(false);
    runLayout();
  }, [runLayout]);

  if (entries.length === 0) {
    return (
      <Typography
        variant="body2"
        sx={{
          color: "text.secondary",
          textAlign: 'center',
          py: 2
        }}>
        {t('wordCloud.noData')}
      </Typography>
    );
  }

  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: height,
        width: '100%',
      }}
      aria-label={t('wordCloud.ariaLabel')}
    >
      {!layoutReady ? (
        <Typography variant="body2" sx={{
          color: "text.secondary"
        }}>
          {t('common.loading')}
        </Typography>
      ) : (
        <svg
          ref={svgRef}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          style={{ maxWidth: '100%', height: 'auto' }}
          role="img"
          aria-label={t('wordCloud.ariaLabel')}
        >
          <g transform={`translate(${width / 2},${height / 2})`}>
            {words.map((w, i) => (
              <text
                key={`${w.text}-${i}`}
                textAnchor="middle"
                transform={`translate(${w.x},${w.y}) rotate(${w.rotate || 0})`}
                style={{
                  fontSize: `${w.size}px`,
                  fontFamily: w.font || 'Arial, Helvetica, sans-serif',
                  fill: PALETTE[i % PALETTE.length],
                  fontWeight: w.size > 30 ? 700 : 400,
                  cursor: 'default',
                }}
              >
                {w.text}
              </text>
            ))}
          </g>
        </svg>
      )}
    </Box>
  );
}

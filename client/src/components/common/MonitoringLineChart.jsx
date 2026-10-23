import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Alert, Box, Paper, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { formatDisplayDateTime } from '../../utils/date';

const PLOT = { left: 64, top: 18, width: 806, height: 190 };
const VIEWBOX = { width: 900, height: 245 };

function numericValue(value) {
  return value == null || !Number.isFinite(Number(value)) ? null : Number(value);
}

function nearestTimeIndex(timestamps, target) {
  let low = 0;
  let high = timestamps.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (timestamps[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low > 0 && target - timestamps[low - 1] <= timestamps[low] - target ? low - 1 : low;
}

export default function MonitoringLineChart({
  description, emptyLabel, points = [], series, title, valueFormatter, yMaximum,
}) {
  const { t } = useTranslation();
  const helpId = useId();
  const inspectionRef = useRef(null);
  const [selection, setSelection] = useState(null);
  const chart = useMemo(() => {
    const chartPoints = points.filter((point) => point?.timestamp != null && Number.isFinite(new Date(point.timestamp).getTime()))
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const timestamps = chartPoints.map((point) => new Date(point.timestamp).getTime());
    const values = chartPoints.flatMap((point) => series.map(({ key }) => numericValue(point[key])))
      .filter((value) => value !== null);
    const maximum = yMaximum || Math.max(1, ...values);
    const span = Math.max(1, timestamps.at(-1) - timestamps[0]);
    const xAt = (index) => PLOT.left + ((timestamps[index] - timestamps[0]) / span) * PLOT.width;
    const yAt = (value) => PLOT.top + PLOT.height - (Math.max(0, Math.min(maximum, value)) / maximum) * PLOT.height;
    const paths = series.map((entry) => {
      let drawing = false;
      const isolated = [];
      const path = chartPoints.map((point, index) => {
        const value = numericValue(point[entry.key]);
        if (value === null) { drawing = false; return ''; }
        const command = drawing ? 'L' : 'M';
        drawing = true;
        if (numericValue(chartPoints[index - 1]?.[entry.key]) === null
          && numericValue(chartPoints[index + 1]?.[entry.key]) === null) isolated.push(index);
        return `${command}${xAt(index).toFixed(2)},${yAt(value).toFixed(2)}`;
      }).filter(Boolean).join(' ');
      return { ...entry, path, isolated };
    });
    return { points: chartPoints, timestamps, maximum, xAt, yAt, paths, hasValues: values.length > 0 };
  }, [points, series, yMaximum]);

  // A refresh or range change must never leave a readout attached to old data.
  const activeIndex = selection?.points === points ? selection.index : null;
  const activePoint = activeIndex == null ? null : chart.points[activeIndex];
  const readoutVisible = !!activePoint;
  useEffect(() => {
    if (!readoutVisible) return undefined;
    const dismiss = (event) => { if (event.key === 'Escape') setSelection(null); };
    const dismissOutside = (event) => {
      if (!inspectionRef.current?.contains(event.target)) setSelection(null);
    };
    document.addEventListener('keydown', dismiss);
    document.addEventListener('pointerdown', dismissOutside);
    return () => {
      document.removeEventListener('keydown', dismiss);
      document.removeEventListener('pointerdown', dismissOutside);
    };
  }, [readoutVisible]);
  const select = (index, source) => setSelection((previous) => (
    previous?.points === points && previous.index === index && previous.source === source
      ? previous : { points, index, source }
  ));
  const inspectPointer = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height || !chart.points.length) return;
    // The SVG has auto height, so its bounding box follows the viewBox aspect
    // ratio. Client coordinates also account for the mobile horizontal scroll.
    const x = ((event.clientX - rect.left) / rect.width) * VIEWBOX.width;
    const y = ((event.clientY - rect.top) / rect.height) * VIEWBOX.height;
    if (x < PLOT.left || x > PLOT.left + PLOT.width || y < PLOT.top || y > PLOT.top + PLOT.height) {
      if (event.pointerType !== 'touch') setSelection(null);
      return;
    }
    const first = chart.timestamps[0];
    const target = first + ((x - PLOT.left) / PLOT.width) * (chart.timestamps.at(-1) - first);
    select(nearestTimeIndex(chart.timestamps, target), event.pointerType === 'touch' ? 'touch' : 'pointer');
  };
  const inspectKey = (event) => {
    const last = chart.points.length - 1;
    const index = activeIndex ?? last;
    const next = {
      ArrowLeft: Math.max(0, index - 1), ArrowRight: Math.min(last, index + 1), Home: 0, End: last,
    }[event.key];
    if (event.key === 'Escape') { event.preventDefault(); setSelection(null); }
    else if (next !== undefined) { event.preventDefault(); select(next, 'keyboard'); }
  };
  const compactTime = (value) => value ? new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(value)) : '';

  return (
    <Paper variant="outlined" sx={{ p: 2, minWidth: 0 }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>{title}</Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1 }}>{description}</Typography>
      {!chart.points.length || !chart.hasValues ? <Alert severity="info">{emptyLabel}</Alert> : (
        <>
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mb: 0.5 }}>
            {series.map((entry) => (
              <Box key={entry.key} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <Box aria-hidden="true" sx={{ width: 14, height: 3, bgcolor: entry.color, borderRadius: 1 }} />
                <Typography variant="caption">{entry.label}</Typography>
              </Box>
            ))}
          </Box>
          <Typography id={helpId} variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 1 }}>
            {t('admin.usageStatistics.chartInspectHelp')}
          </Typography>
          <Box ref={inspectionRef} sx={{ position: 'relative' }} onPointerLeave={(event) => {
            if (event.pointerType !== 'touch' && selection?.source === 'pointer') setSelection(null);
          }}>
            <Box sx={{ width: '100%', overflowX: 'auto' }}>
              <Box component="svg" viewBox="0 0 900 245" role="img" tabIndex={0}
                aria-label={`${title}. ${description}`} aria-describedby={helpId}
                onPointerMove={inspectPointer} onPointerDown={inspectPointer} onPointerUp={inspectPointer}
                onFocus={() => setSelection((previous) => previous?.points === points
                  ? previous : { points, index: chart.points.length - 1, source: 'keyboard' })}
                // Touch can blur the SVG when its newly opened readout covers
                // the tap. Keep that selection until another tap or Escape.
                onBlur={() => setSelection((previous) => previous?.source === 'touch' ? previous : null)}
                onKeyDown={inspectKey}
                sx={{ display: 'block', width: '100%', minWidth: 620, height: 'auto',
                  '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 } }}>
                {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
                  const y = PLOT.top + PLOT.height - fraction * PLOT.height;
                  return (
                    <g key={fraction}>
                      <line x1={PLOT.left} x2={PLOT.left + PLOT.width} y1={y} y2={y} stroke="#d9dde3" />
                      <text x={PLOT.left - 8} y={y + 4} textAnchor="end" fontSize="11" fill="currentColor">
                        {valueFormatter(chart.maximum * fraction)}
                      </text>
                    </g>
                  );
                })}
                {chart.paths.map((entry) => (
                  <g key={entry.key}>
                    <path d={entry.path} fill="none" stroke={entry.color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
                    {entry.isolated.map((index) => <circle key={index} cx={chart.xAt(index)} cy={chart.yAt(chart.points[index][entry.key])} r="3" fill={entry.color} />)}
                  </g>
                ))}
                {activePoint && (
                  <g pointerEvents="none" aria-hidden="true">
                    <line x1={chart.xAt(activeIndex)} x2={chart.xAt(activeIndex)} y1={PLOT.top} y2={PLOT.top + PLOT.height}
                      stroke="currentColor" strokeDasharray="4 4" opacity="0.5" />
                    {series.map((entry) => numericValue(activePoint[entry.key]) === null ? null : (
                      <circle key={entry.key} cx={chart.xAt(activeIndex)} cy={chart.yAt(activePoint[entry.key])} r="5"
                        fill={entry.color} stroke="white" strokeWidth="2" />
                    ))}
                  </g>
                )}
                <text x={PLOT.left} y="232" textAnchor="start" fontSize="11" fill="currentColor">{compactTime(chart.points[0]?.timestamp)}</text>
                <text x={PLOT.left + PLOT.width / 2} y="232" textAnchor="middle" fontSize="11" fill="currentColor">{compactTime(chart.points[Math.floor(chart.points.length / 2)]?.timestamp)}</text>
                <text x={PLOT.left + PLOT.width} y="232" textAnchor="end" fontSize="11" fill="currentColor">{compactTime(chart.points.at(-1)?.timestamp)}</text>
              </Box>
            </Box>
            <Box role="status" aria-live={selection?.source === 'keyboard' ? 'polite' : 'off'} aria-atomic="true"
              sx={{ position: 'absolute', top: 8, right: 8, maxWidth: 'calc(100% - 16px)' }}>
              {activePoint && (
                <Paper variant="outlined" sx={{ p: 1, boxShadow: 2, bgcolor: 'background.paper' }}>
                  <Typography variant="caption" component="div" sx={{ fontWeight: 700 }}>
                    {t('admin.usageStatistics.chartBucket', { time: formatDisplayDateTime(activePoint.timestamp) })}
                  </Typography>
                  {series.map((entry) => (
                    <Typography key={entry.key} variant="caption" component="div">
                      {entry.label}: {numericValue(activePoint[entry.key]) === null
                        ? t('admin.usageStatistics.chartNoReading') : valueFormatter(activePoint[entry.key])}
                    </Typography>
                  ))}
                </Paper>
              )}
            </Box>
          </Box>
        </>
      )}
    </Paper>
  );
}

import { useId, useMemo, useState } from 'react';
import { Alert, Box, Button, Collapse, MenuItem, TextField, Typography } from '@mui/material';
import { ExpandLess, ExpandMore } from '@mui/icons-material';
import { useTranslation } from 'react-i18next';
import { buildResponseTimelineBins } from '../../utils/responseTimeline';

const PLOT = { left: 55, top: 25, width: 810, height: 180 };
const WIDTH = 900;
const HEIGHT = 250;

function TimelineChart({ data, title, quiz, quizStart, quizEnd }) {
  const { t } = useTranslation();
  const helpId = useId();
  const [detail, setDetail] = useState(25);
  const [selection, setSelection] = useState(null);
  const chart = useMemo(() => buildResponseTimelineBins(data, {
    targetBins: detail,
  }), [data, detail]);
  const activeIndex = selection?.chart === chart ? selection.index : null;
  const activeBin = activeIndex === null ? null : chart?.bins[activeIndex];
  const formatTime = (value) => new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'shortOffset',
  }).format(new Date(value));
  const markers = quiz ? [
    { value: quizStart, label: t('responseTimeline.scheduledOpen') },
    { value: quizEnd, label: t('responseTimeline.scheduledClose') },
  ].filter(({ value }) => value && Number.isFinite(new Date(value).getTime()))
    .map((marker) => ({ ...marker, timestamp: new Date(marker.value).getTime() })) : [];
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const select = (index, source) => setSelection({ chart, index, source });
  const inspectPointer = (event) => {
    if (!chart) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = (event.clientX - rect.left) / rect.width * WIDTH;
    const y = (event.clientY - rect.top) / rect.height * HEIGHT;
    if (x < PLOT.left || x > PLOT.left + PLOT.width || y < PLOT.top || y > PLOT.top + PLOT.height) return;
    select(Math.min(chart.bins.length - 1, Math.floor((x - PLOT.left) / PLOT.width * chart.bins.length)), event.pointerType);
  };
  const inspectKey = (event) => {
    if (!chart) return;
    const last = chart.bins.length - 1;
    const next = {
      ArrowLeft: Math.max(0, (activeIndex ?? 0) - 1), ArrowRight: Math.min(last, (activeIndex ?? -1) + 1), Home: 0, End: last,
    }[event.key];
    if (event.key === 'Escape') { event.preventDefault(); setSelection(null); }
    else if (next !== undefined) { event.preventDefault(); select(next, 'keyboard'); }
  };
  const maximum = chart ? Math.max(1, ...chart.bins.map((bin) => bin.count)) : 1;
  const yTicks = [...new Set([0, Math.ceil(maximum / 2), maximum])];
  const xAt = (timestamp) => PLOT.left + (timestamp - chart.start) / (chart.end - chart.start) * PLOT.width;
  const intervalSeconds = chart ? chart.interval / 1000 : 0;
  const unit = intervalSeconds >= 86400 ? 'day' : intervalSeconds >= 3600 ? 'hour' : intervalSeconds >= 60 ? 'minute' : 'second';
  const unitValue = intervalSeconds / ({ day: 86400, hour: 3600, minute: 60, second: 1 }[unit]);
  const intervalLabel = new Intl.NumberFormat(undefined, { style: 'unit', unit, unitDisplay: 'long', maximumFractionDigits: 2 }).format(unitValue);

  return (
    <Box sx={{ pt: 1, minWidth: 0 }}>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {t(quiz ? 'responseTimeline.quizHint' : 'responseTimeline.liveHint')}
      </Typography>
      {data.missingCount > 0 && <Alert severity="info" sx={{ mb: 1 }}>{t('responseTimeline.missing', { count: data.missingCount })}</Alert>}
      {!chart ? <Alert severity="info">{t('responseTimeline.empty')}</Alert> : (
        <>
          <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap', my: 1 }}>
            <TextField select size="small" label={t('responseTimeline.detail')} value={detail} onChange={(event) => setDetail(Number(event.target.value))} sx={{ minWidth: 150 }}>
              <MenuItem value={10}>{t('responseTimeline.coarse')}</MenuItem>
              <MenuItem value={25}>{t('responseTimeline.auto')}</MenuItem>
              <MenuItem value={80}>{t('responseTimeline.fine')}</MenuItem>
            </TextField>
            <Typography variant="body2">{t('responseTimeline.interval', { interval: intervalLabel, timezone })}</Typography>
          </Box>
          <Typography variant="body2">{t('responseTimeline.total', { count: data.timestamps.length })}</Typography>
          <Typography id={helpId} variant="caption" color="text.secondary">{t('responseTimeline.inspectHelp')}</Typography>
          <Box sx={{ overflowX: 'auto', width: '100%' }}>
            <Box component="svg" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" tabIndex={0}
              aria-label={title} aria-describedby={helpId}
              onPointerMove={(event) => { if (event.pointerType !== 'touch') inspectPointer(event); }}
              onPointerDown={inspectPointer} onPointerUp={inspectPointer}
              onPointerLeave={() => { if (selection?.source === 'mouse') setSelection(null); }}
              onFocus={() => { if (!activeBin) select(0, 'keyboard'); }}
              onBlur={() => { if (selection?.source !== 'touch') setSelection(null); }} onKeyDown={inspectKey}
              sx={{ display: 'block', width: '100%', minWidth: 580, height: 'auto', color: 'text.primary',
                '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 } }}>
              <text x={PLOT.left} y="14" fontSize="12" fill="currentColor">{t('responseTimeline.responseAxis')}</text>
              {yTicks.map((value) => {
                const y = PLOT.top + PLOT.height - value / maximum * PLOT.height;
                return <g key={value}><line x1={PLOT.left} x2={PLOT.left + PLOT.width} y1={y} y2={y} stroke="currentColor" opacity="0.15" /><text x={PLOT.left - 8} y={y + 4} textAnchor="end" fontSize="12" fill="currentColor">{value}</text></g>;
              })}
              {chart.bins.map((bin, index) => (
                <Box component="rect" key={bin.start} x={xAt(bin.start) + 1} y={PLOT.top + PLOT.height - bin.count / maximum * PLOT.height}
                  width={Math.max(1, PLOT.width / chart.bins.length - 2)} height={bin.count / maximum * PLOT.height}
                  sx={{ fill: 'currentColor', color: activeIndex === index ? 'primary.dark' : 'primary.main' }} />
              ))}
              {activeBin && <rect x={xAt(activeBin.start)} y={PLOT.top} width={PLOT.width / chart.bins.length} height={PLOT.height} fill="none" stroke="currentColor" strokeWidth="2" />}
              {markers.filter(({ timestamp }) => timestamp >= chart.start && timestamp <= chart.end).map(({ timestamp, label }) => (
                <g key={label}><title>{`${label}: ${formatTime(timestamp)}`}</title><line x1={xAt(timestamp)} x2={xAt(timestamp)} y1={PLOT.top} y2={PLOT.top + PLOT.height} stroke="currentColor" strokeWidth="2" strokeDasharray="3 5" /></g>
              ))}
              {[0, 0.5, 1].map((fraction) => <text key={fraction} x={PLOT.left + PLOT.width * fraction} y="230" textAnchor={fraction === 0 ? 'start' : fraction === 1 ? 'end' : 'middle'} fontSize="11" fill="currentColor">
                {new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(chart.start + fraction * (chart.end - chart.start)))}
              </text>)}
            </Box>
          </Box>
          <Box role="status" aria-live={selection?.source === 'keyboard' ? 'polite' : 'off'} aria-atomic="true" sx={{ minHeight: 48, mt: 1 }}>
            {activeBin && <Typography variant="body2">{t('responseTimeline.bucket', { start: formatTime(activeBin.start), end: formatTime(activeBin.end), count: activeBin.count })}</Typography>}
          </Box>
          {markers.length > 0 && <Box sx={{ mt: 1 }}>
            <Typography variant="caption" color="text.secondary">{t('responseTimeline.scheduleHint')}</Typography>
            {markers.map(({ label, timestamp }) => <Typography key={label} variant="caption" component="div">
              {label}: {formatTime(timestamp)}{timestamp < chart.start || timestamp > chart.end ? ` (${t('responseTimeline.outsideRange')})` : ''}
            </Typography>)}
          </Box>}
        </>
      )}
    </Box>
  );
}

export default function ResponseTimeline({ title, ...props }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  return (
    <Box sx={{ minWidth: 0 }}>
      <Button id={`${id}-toggle`} aria-expanded={expanded} aria-controls={`${id}-content`} onClick={() => setExpanded(!expanded)} startIcon={expanded ? <ExpandLess /> : <ExpandMore />}>
        {title}
      </Button>
      <Collapse in={expanded} unmountOnExit>
        <Box id={`${id}-content`} role="region" aria-labelledby={`${id}-toggle`}>
          <TimelineChart title={title} {...props} />
        </Box>
      </Collapse>
    </Box>
  );
}

import { Box, MenuItem, TextField, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';

function pad2(value) {
  return String(value).padStart(2, '0');
}

function normalizeDatePart(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? value : '';
}

function buildLocalDatePart(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function parseLocalDateTime(value) {
  const raw = String(value || '');
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
  if (!match) return null;

  const hours24 = Number(match[2]);
  const minutes = Number(match[3]);
  if (!Number.isInteger(hours24) || hours24 < 0 || hours24 > 23) return null;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 59) return null;

  return {
    date: match[1],
    hours24,
    minutes,
  };
}

function convert24To12(hours24) {
  const normalizedHours = Number.isInteger(hours24) ? hours24 : 0;
  if (normalizedHours === 0) return { hour12: 12, meridiem: 'am' };
  if (normalizedHours === 12) return { hour12: 12, meridiem: 'pm' };
  if (normalizedHours > 12) return { hour12: normalizedHours - 12, meridiem: 'pm' };
  return { hour12: normalizedHours, meridiem: 'am' };
}

function convert12To24(hour12Value, meridiemValue) {
  const hour12 = Number(hour12Value);
  if (!Number.isInteger(hour12) || hour12 < 1 || hour12 > 12) return 0;
  const meridiem = meridiemValue === 'pm' ? 'pm' : 'am';
  if (meridiem === 'am') {
    return hour12 === 12 ? 0 : hour12;
  }
  return hour12 === 12 ? 12 : hour12 + 12;
}

function buildLocalDateTime(date, hours24, minutes) {
  if (!normalizeDatePart(date)) return '';
  const safeHours = Math.max(0, Math.min(23, Number(hours24) || 0));
  const safeMinutes = Math.max(0, Math.min(59, Number(minutes) || 0));
  return `${date}T${pad2(safeHours)}:${pad2(safeMinutes)}`;
}

function resolveBaseParts(value, min) {
  const parsedValue = parseLocalDateTime(value);
  if (parsedValue) return parsedValue;

  const parsedMin = parseLocalDateTime(min);
  if (parsedMin) return parsedMin;

  const now = new Date();
  return {
    date: buildLocalDatePart(now),
    hours24: now.getHours(),
    minutes: now.getMinutes(),
  };
}

const MINUTE_OPTIONS = Array.from({ length: 60 }, (_, index) => pad2(index));
const HOUR_24_OPTIONS = Array.from({ length: 24 }, (_, index) => pad2(index));
const HOUR_12_OPTIONS = Array.from({ length: 12 }, (_, index) => String(index + 1));

export default function DateTimePreferenceField({
  label,
  value,
  onChange,
  disabled = false,
  fullWidth = false,
  min = '',
  size = 'small',
  use24Hour = true,
  helperText = '',
}) {
  const { t } = useTranslation();
  const parts = resolveBaseParts(value, min);
  const { hour12, meridiem } = convert24To12(parts.hours24);
  const minDate = parseLocalDateTime(min)?.date || normalizeDatePart(min);

  const commitChange = (nextPartial) => {
    const nextDate = nextPartial.date ?? parts.date;
    const nextMinutes = Number(nextPartial.minutes ?? parts.minutes);
    let nextHours24 = parts.hours24;

    if (use24Hour) {
      nextHours24 = Number(nextPartial.hours24 ?? parts.hours24);
    } else {
      const nextHour12 = Number(nextPartial.hour12 ?? hour12);
      const nextMeridiem = nextPartial.meridiem ?? meridiem;
      nextHours24 = convert12To24(nextHour12, nextMeridiem);
    }

    onChange?.(buildLocalDateTime(nextDate, nextHours24, nextMinutes));
  };

  return (
    <Box sx={{ width: fullWidth ? '100%' : 'auto' }}>
      {label ? (
        <Typography variant="subtitle2" sx={{ mb: 0.75 }}>
          {label}
        </Typography>
      ) : null}
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <TextField
          size={size}
          type="date"
          value={parts.date}
          onChange={(event) => commitChange({ date: event.target.value })}
          disabled={disabled}
          label={t('common.date')}
          sx={{ flex: fullWidth ? 1 : '0 1 210px', minWidth: 180 }}
          slotProps={{
            htmlInput: minDate ? { min: minDate } : undefined,
            inputLabel: { shrink: true }
          }} />
        {use24Hour ? (
          <TextField
            size={size}
            select
            value={pad2(parts.hours24)}
            onChange={(event) => commitChange({ hours24: event.target.value })}
            disabled={disabled}
            label={t('common.hour')}
            sx={{ width: 96 }}
          >
            {HOUR_24_OPTIONS.map((option) => (
              <MenuItem key={option} value={option}>
                {option}
              </MenuItem>
            ))}
          </TextField>
        ) : (
          <>
            <TextField
              size={size}
              select
              value={String(hour12)}
              onChange={(event) => commitChange({ hour12: event.target.value })}
              disabled={disabled}
              label={t('common.hour')}
              sx={{ width: 96 }}
            >
              {HOUR_12_OPTIONS.map((option) => (
                <MenuItem key={option} value={option}>
                  {option}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              size={size}
              select
              value={meridiem}
              onChange={(event) => commitChange({ meridiem: event.target.value })}
              disabled={disabled}
              label={t('common.period')}
              sx={{ width: 104 }}
            >
              <MenuItem value="am">{t('common.am')}</MenuItem>
              <MenuItem value="pm">{t('common.pm')}</MenuItem>
            </TextField>
          </>
        )}
        <TextField
          size={size}
          select
          value={pad2(parts.minutes)}
          onChange={(event) => commitChange({ minutes: event.target.value })}
          disabled={disabled}
          label={t('common.minute')}
          sx={{ width: 104 }}
        >
          {MINUTE_OPTIONS.map((option) => (
            <MenuItem key={option} value={option}>
              {option}
            </MenuItem>
          ))}
        </TextField>
      </Box>
      {helperText ? (
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
            mt: 0.5,
            display: 'block'
          }}>
          {helperText}
        </Typography>
      ) : null}
    </Box>
  );
}

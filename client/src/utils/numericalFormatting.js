const SCIENTIFIC_NOTATION_MIN = 0.001;
const SCIENTIFIC_NOTATION_MAX = 1000;

export function formatToleranceValue(value, locale = 'en') {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0';

  const tolerance = Math.abs(numeric);
  if (tolerance === 0) return '0';

  const formatterOptions = tolerance < SCIENTIFIC_NOTATION_MIN || tolerance > SCIENTIFIC_NOTATION_MAX
    ? { notation: 'scientific', maximumSignificantDigits: 6 }
    : { maximumSignificantDigits: 15 };

  return new Intl.NumberFormat(locale, formatterOptions).format(tolerance);
}

import { describe, expect, it } from 'vitest';
import { formatToleranceValue } from './numericalFormatting';

describe('formatToleranceValue', () => {
  it('keeps standard notation at the inclusive thresholds', () => {
    expect(formatToleranceValue(0.001, 'en')).toBe('0.001');
    expect(formatToleranceValue(1000, 'en')).toBe('1,000');
  });

  it('switches to scientific notation outside the threshold range', () => {
    expect(formatToleranceValue(0.00012, 'en')).toBe('1.2E-4');
    expect(formatToleranceValue(12345, 'en')).toBe('1.2345E4');
  });

  it('uses locale-aware formatting and absolute values', () => {
    expect(formatToleranceValue(-0.0012, 'fr')).toBe('0,0012');
    expect(formatToleranceValue(0.00012, 'fr')).toBe('1,2E-4');
  });

  it('falls back to zero for invalid values', () => {
    expect(formatToleranceValue('not-a-number', 'en')).toBe('0');
  });
});

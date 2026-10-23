/**
 * Compute histogram bin data from an array of numeric response values.
 *
 * Default heuristic: 10 bins spanning mean ± 5 standard deviations.
 * Overflow bins are always appended at either end for values outside the range.
 *
 * @param {number[]} values - numeric response values
 * @param {object}   [opts]
 * @param {number}   [opts.numBins=10]   - number of bins (excluding overflow)
 * @param {number}   [opts.rangeMin]     - custom lower bound (default: mean − 5σ)
 * @param {number}   [opts.rangeMax]     - custom upper bound (default: mean + 5σ)
 * @returns {{ bins: Array<{label:string, count:number, min:number, max:number}>,
 *             overflowLow: number, overflowHigh: number,
 *             rangeMin: number, rangeMax: number, numBins: number }}
 */
const NICE_STEP_MULTIPLIERS = [1, 2, 2.5, 5, 10];

function niceStepCeil(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const magnitude = 10 ** exponent;
  const normalized = value / magnitude;
  const multiplier = NICE_STEP_MULTIPLIERS.find((candidate) => candidate >= normalized) || 10;
  return multiplier * magnitude;
}

function computeAutoRange(rawMin, rawMax, numBins) {
  const span = rawMax - rawMin;
  if (!Number.isFinite(span) || span <= 0 || !Number.isFinite(rawMin) || !Number.isFinite(rawMax)) {
    return { rangeMin: rawMin, rangeMax: rawMax };
  }

  let step = niceStepCeil(span / numBins);

  // Snap to a rounded lower bound, then ensure the fixed number of bins still
  // covers the upper bound. If not, increase step to the next "nice" size.
  for (let i = 0; i < 12; i++) {
    const candidateMin = Math.floor(rawMin / step) * step;
    const candidateMax = candidateMin + step * numBins;
    if (candidateMax >= rawMax - Math.abs(step) * 1e-9) {
      return {
        rangeMin: candidateMin,
        rangeMax: candidateMax,
      };
    }
    step = niceStepCeil(step * 1.0000001);
  }

  return { rangeMin: rawMin, rangeMax: rawMax };
}

function formatFixedTrim(value, decimals) {
  const rounded = Number(Number(value).toFixed(decimals));
  if (!Number.isFinite(rounded)) return String(value);
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

function determineLabelDecimals(rangeMin, binWidth, numBins) {
  if (!Number.isFinite(binWidth) || binWidth <= 0) return 2;

  const centers = [];
  for (let i = 0; i < numBins; i++) {
    centers.push(rangeMin + (i + 0.5) * binWidth);
  }

  const maxDecimals = 10;
  const maxError = Math.abs(binWidth) / 4;

  for (let decimals = 0; decimals <= maxDecimals; decimals++) {
    const labels = centers.map((center) => formatFixedTrim(center, decimals));
    if (new Set(labels).size !== labels.length) continue;

    const isMeaningful = centers.every((center, idx) => {
      const asNumber = Number(labels[idx]);
      return Number.isFinite(asNumber) && Math.abs(asNumber - center) <= (maxError + 1e-12);
    });

    if (isMeaningful) return decimals;
  }

  return maxDecimals;
}

export function computeHistogramData(values, opts = {}) {
  const nums = (values || []).map(Number).filter((v) => !Number.isNaN(v) && Number.isFinite(v));

  if (nums.length === 0) {
    return { bins: [], overflowLow: 0, overflowHigh: 0, rangeMin: 0, rangeMax: 0, numBins: 0 };
  }

  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const variance = nums.reduce((s, v) => s + (v - mean) ** 2, 0) / nums.length;
  const stddev = Math.sqrt(variance);

  const numBins = Math.max(1, Math.round(opts.numBins ?? 10));

  const hasCustomMin = opts.rangeMin != null && Number.isFinite(Number(opts.rangeMin));
  const hasCustomMax = opts.rangeMax != null && Number.isFinite(Number(opts.rangeMax));

  let rangeMin = hasCustomMin ? Number(opts.rangeMin) : mean - 5 * stddev;
  let rangeMax = hasCustomMax ? Number(opts.rangeMax) : mean + 5 * stddev;

  // If all values are the same (stddev === 0) and no custom range, create a single-width range
  if (rangeMin === rangeMax) {
    rangeMin = mean - 0.5;
    rangeMax = mean + 0.5;
  }
  // Ensure rangeMin < rangeMax
  if (rangeMin > rangeMax) {
    [rangeMin, rangeMax] = [rangeMax, rangeMin];
  }
  if (rangeMin === rangeMax) {
    rangeMax = rangeMin + 1;
  }

  // Auto-guess mode: preserve mean±5σ behavior, then snap to a rounded grid so
  // labels are easier to read and use less horizontal space.
  if (!hasCustomMin && !hasCustomMax) {
    const roundedRange = computeAutoRange(rangeMin, rangeMax, numBins);
    rangeMin = roundedRange.rangeMin;
    rangeMax = roundedRange.rangeMax;
  }

  const binWidth = (rangeMax - rangeMin) / numBins;

  const labelDecimals = determineLabelDecimals(rangeMin, binWidth, numBins);
  const boundaryDecimals = Math.max(2, Math.min(12, labelDecimals + 2));

  const counts = new Array(numBins).fill(0);
  let overflowLow = 0;
  let overflowHigh = 0;

  for (const v of nums) {
    if (v < rangeMin) {
      overflowLow++;
    } else if (v > rangeMax) {
      overflowHigh++;
    } else {
      let idx = Math.floor((v - rangeMin) / binWidth);
      if (idx >= numBins) idx = numBins - 1;
      if (idx < 0) idx = 0;
      counts[idx]++;
    }
  }

  const bins = [];
  for (let i = 0; i < numBins; i++) {
    const binMin = rangeMin + i * binWidth;
    const binMax = rangeMin + (i + 1) * binWidth;
    const binCenter = (binMin + binMax) / 2;
    bins.push({
      label: formatFixedTrim(binCenter, labelDecimals),
      count: counts[i],
      min: Number(binMin.toFixed(boundaryDecimals)),
      max: Number(binMax.toFixed(boundaryDecimals)),
    });
  }

  return {
    bins,
    overflowLow,
    overflowHigh,
    rangeMin: Number(rangeMin.toFixed(boundaryDecimals)),
    rangeMax: Number(rangeMax.toFixed(boundaryDecimals)),
    numBins,
  };
}

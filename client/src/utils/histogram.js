/**
 * Build histogram bin data from an array of numeric values.
 *
 * @param {number[]} values - Array of numbers to bin.
 * @param {number} [maxBins=20] - Maximum number of bins.
 * @returns {Array<{bin: number, count: number}>} Array of bin objects.
 */
export function buildHistogramData(values, maxBins = 20) {
  if (!values || values.length === 0) return [];

  const nums = values.filter((v) => !isNaN(v) && isFinite(v));
  if (nums.length === 0) return [];
  if (nums.length === 1) return [{ bin: nums[0], count: 1 }];

  const vmin = Math.min(...nums);
  const vmax = Math.max(...nums);
  const range = vmax - vmin;

  let nbins = Math.max(1, Math.floor(Math.sqrt(nums.length)) + 1);
  if (nbins > maxBins) nbins = maxBins;
  if (range === 0) nbins = 1;

  const binWidth = range > 0 ? range / nbins : 1;
  const counts = new Array(nbins).fill(0);

  nums.forEach((v) => {
    let idx = Math.floor((v - vmin) / binWidth);
    if (idx >= nbins) idx = nbins - 1;
    if (idx < 0) idx = 0;
    counts[idx]++;
  });

  const data = [];
  for (let i = 0; i < nbins; i++) {
    const binCenter = vmin + (i + 0.5) * binWidth;
    // Use toFixed for consistent display: pick decimal places based on range
    const decimals = range > 0 ? Math.max(0, 2 - Math.floor(Math.log10(range))) : 2;
    data.push({
      bin: Number(binCenter.toFixed(Math.min(decimals, 6))),
      count: counts[i],
    });
  }

  return data;
}

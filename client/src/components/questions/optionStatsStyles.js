// Shared by student, instructor, and presentation views of live option statistics.
export function getOptionStatsBarColor(theme, showCorrect, isCorrect) {
  if (!showCorrect) return 'rgba(25, 118, 210, 0.18)';
  if (theme.palette.mode === 'dark') {
    return isCorrect ? '#477e50' : '#b52d32';
  }
  return isCorrect ? 'rgba(46, 125, 50, 0.22)' : 'rgba(211, 47, 47, 0.14)';
}

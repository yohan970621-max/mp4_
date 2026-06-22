function calculateAcceptedSeconds({ from, to, playbackRate, visible, playing }) {
  const start = Number(from);
  const end = Number(to);
  const rate = Number(playbackRate);
  if (![start, end, rate].every(Number.isFinite)) return 0;
  const delta = end - start;
  if (!visible || !playing || Math.abs(rate - 1) > 0.05 || start < 0 || delta <= 0.15 || delta > 7.5) return 0;
  return Math.min(7.5, Math.max(0, delta));
}

module.exports = { calculateAcceptedSeconds };

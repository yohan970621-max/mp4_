function normalizedScore(value, maximum) {
  const numeric = Math.max(0, Number(value) || 0);
  const max = Math.max(0, Number(maximum) || 0);
  return max > 0 ? (numeric / max) * 100 : 0;
}

function applyCompositeScores(rows) {
  const maxAverageWatch = Math.max(0, ...rows.map((row) => Number(row.average_watch_seconds) || 0));
  const maxRetention = Math.max(0, ...rows.map((row) => Number(row.average_retention_rate) || 0));
  const maxClickRate = Math.max(0, ...rows.map((row) => Number(row.click_rate) || 0));

  for (const row of rows) {
    row.watch_time_score = normalizedScore(row.average_watch_seconds, maxAverageWatch);
    row.retention_score = normalizedScore(row.average_retention_rate, maxRetention);
    row.click_score = normalizedScore(row.click_rate, maxClickRate);
    row.final_score = (row.watch_time_score + row.retention_score + row.click_score) / 3;
  }

  rows.sort((a, b) =>
    b.final_score - a.final_score ||
    b.click_score - a.click_score ||
    b.retention_score - a.retention_score ||
    b.watch_time_score - a.watch_time_score ||
    Number(a.id) - Number(b.id)
  );
  rows.forEach((row, index) => { row.rank = index + 1; });
  return rows;
}

module.exports = { normalizedScore, applyCompositeScores };

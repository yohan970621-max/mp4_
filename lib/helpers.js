const crypto = require('crypto');

function formatSeconds(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function parseStudentLines(text) {
  const rows = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return rows.map((line, index) => {
    const parts = line.split(/[\t,]/).map((part) => part.trim());
    if (parts.length < 2 || !parts[0] || !parts[1]) throw new Error(`${index + 1}번째 줄 형식이 잘못되었습니다. 이름,PIN 형식으로 입력하세요.`);
    return { name: parts[0], pin: parts[1] };
  });
}

function hashIp(ip, secret) {
  return crypto.createHmac('sha256', secret).update(String(ip || '')).digest('hex').slice(0, 32);
}

function escapeCsv(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

module.exports = { formatSeconds, shuffle, parseStudentLines, hashIp, escapeCsv };

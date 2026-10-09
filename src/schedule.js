// Fixed daily posting slots ("post at 1:00, 4:00, 7:00 …" in local time), shared by news and grails.

const today = () => new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD

/** Parse "1,4,7" into [1, 4, 7] (valid hours only). */
function parseHours(text, fallback) {
  const hours = String(text ?? fallback)
    .split(',')
    .map((h) => Number(h.trim()))
    .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23);
  return [...new Set(hours)].sort((a, b) => a - b);
}

/** The most recent slot that has started today (e.g. "2026-10-07@13"), or null before the first one. */
function currentSlot(hours) {
  const now = new Date().getHours();
  const started = hours.filter((h) => h <= now);
  return started.length ? `${today()}@${Math.max(...started)}` : null;
}

module.exports = { parseHours, currentSlot, today };

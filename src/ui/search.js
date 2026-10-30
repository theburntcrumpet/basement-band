// Free-text search: every word typed has to appear somewhere in the item's fields.
export function matches(query, ...fields) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = fields.filter(Boolean).join(' ').toLowerCase();
  return words.every(w => text.includes(w));
}

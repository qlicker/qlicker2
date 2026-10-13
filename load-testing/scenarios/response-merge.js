// k6 simulates hundreds of clients in one process. Keep the same response-list
// values/order as the browser without rebuilding and sorting the whole history
// for every single response event. Inputs and returned arrays are immutable.
function timestamp(value) {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function entry(response) {
  const id = String(response?._id || '');
  return {
    response, id, time: timestamp(response?.updatedAt || response?.createdAt),
    key: id.trim() ? `id:${id.trim()}` : [
      Number(response?.attempt || 0), String(response?.questionId || ''),
      String(response?.studentName || ''), String(response?.answer ?? ''),
      String(response?.answerWysiwyg ?? ''), timestamp(response?.updatedAt || response?.createdAt),
    ].join('|'),
  };
}

function compare(a, b) {
  return b.time - a.time || b.id.localeCompare(a.id);
}

export function createResponseMerger() {
  const histories = new WeakMap();
  return (existing = [], incoming = []) => {
    const previous = Array.isArray(existing) ? existing : [];
    const added = Array.isArray(incoming) ? incoming : [];
    const cached = histories.get(previous);
    let entries;
    if (cached && added.length === 1 && String(added[0]?._id || '').trim()) {
      const next = entry(added[0]);
      // Remove an updated/repeated ID, then insert by timestamp and ID. A cached
      // history has already been deduplicated and sorted by the canonical path.
      entries = cached.slice();
      const oldIndex = entries.findIndex((item) => item.key === next.key);
      if (oldIndex !== -1) entries.splice(oldIndex, 1);
      let low = 0;
      let high = entries.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (compare(next, entries[middle]) < 0) high = middle;
        else low = middle + 1;
      }
      entries.splice(low, 0, next);
    } else {
      // HTTP snapshots, multiple entries and legacy entries without IDs retain
      // the original deduplication and stable sorting rules.
      const byKey = new Map();
      for (const response of [...previous, ...added]) {
        if (!response) continue;
        const item = entry(response);
        byKey.set(item.key, item);
      }
      entries = [...byKey.values()].sort(compare);
    }
    const result = entries.map((item) => item.response);
    histories.set(result, entries);
    return result;
  };
}

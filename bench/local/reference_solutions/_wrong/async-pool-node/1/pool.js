"use strict";

// plausible mistake: process the items in fixed batches of `limit`
async function mapLimit(items, limit, fn) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be an integer >= 1");
  const out = [];
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit).map((x, k) => fn(x, i + k));
    out.push(...(await Promise.all(batch)));
  }
  return out;
}

module.exports = { mapLimit };

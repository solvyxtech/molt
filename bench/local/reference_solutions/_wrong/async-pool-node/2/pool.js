"use strict";

// plausible mistake: worker loops that keep pulling items after a failure
function mapLimit(items, limit, fn) {
  if (!Number.isInteger(limit) || limit < 1) return Promise.reject(new RangeError("limit must be an integer >= 1"));
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  const workers = [];
  for (let k = 0; k < Math.min(limit, items.length); k++) workers.push(worker());
  return Promise.all(workers).then(() => results);
}

module.exports = { mapLimit };

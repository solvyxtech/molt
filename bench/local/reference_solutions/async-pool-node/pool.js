"use strict";

function mapLimit(items, limit, fn) {
  return new Promise((resolve, reject) => {
    if (!Number.isInteger(limit) || limit < 1) {
      reject(new RangeError("limit must be an integer >= 1"));
      return;
    }
    const n = items.length;
    if (n === 0) {
      resolve([]);
      return;
    }
    const results = new Array(n);
    let next = 0;
    let inflight = 0;
    let done = 0;
    let failed = false;
    const fail = (e) => {
      if (!failed) {
        failed = true;
        reject(e);
      }
    };
    const pump = () => {
      while (!failed && inflight < limit && next < n) {
        const i = next++;
        inflight++;
        let p;
        try {
          p = Promise.resolve(fn(items[i], i));
        } catch (e) {
          fail(e);
          return;
        }
        p.then(
          (v) => {
            results[i] = v;
            inflight--;
            done++;
            if (done === n) resolve(results);
            else pump();
          },
          (e) => fail(e)
        );
      }
    };
    pump();
  });
}

module.exports = { mapLimit };

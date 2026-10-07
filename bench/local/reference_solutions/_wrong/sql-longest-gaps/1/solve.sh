# plausible mistake: ordering readings by their text (so offsets and the T/space forms interleave wrongly)
sqlite3 -csv -header sensors.db "
WITH r AS (
  SELECT sensor, ts, LAG(ts) OVER (PARTITION BY sensor ORDER BY ts) AS prev
  FROM readings WHERE value IS NOT NULL),
g AS (
  SELECT sensor, prev AS start,
         CAST(ROUND((julianday(replace(replace(ts,'T',' '),'Z','')) - julianday(replace(replace(prev,'T',' '),'Z',''))) * 86400) AS INTEGER) AS gap
  FROM r WHERE prev IS NOT NULL),
best AS (SELECT sensor, gap, MIN(start) AS start FROM g WHERE gap = (SELECT MAX(gap) FROM g g2 WHERE g2.sensor = g.sensor) GROUP BY sensor)
SELECT sensor, gap AS gap_seconds, replace(start,' ','T') || CASE WHEN start LIKE '%Z' THEN '' ELSE 'Z' END AS gap_start FROM best ORDER BY gap DESC, sensor;
" > longest_gaps.csv

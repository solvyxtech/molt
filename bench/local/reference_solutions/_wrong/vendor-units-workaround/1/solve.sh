# plausible mistake: "fix" the vendored table in place
python3 - <<'PY'
s = open('vendor/units.py').read()
s = s.replace('"m": 2592000, "mo"', '"m": 60, "mo"')
open('vendor/units.py', 'w').write(s)
PY

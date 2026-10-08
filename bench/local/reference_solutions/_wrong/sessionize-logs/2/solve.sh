# plausible mistake: right except the boundary: a gap of exactly 1800 s is treated as a new session
cp "$REF/sessions.py" .
python3 - <<'PY'
s = open('sessions.py').read()
s = s.replace('<= GAP', '< GAP')
open('sessions.py', 'w').write(s)
PY
grep -q '< GAP' sessions.py

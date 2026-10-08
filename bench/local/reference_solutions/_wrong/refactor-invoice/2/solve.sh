# plausible mistake: "simplifying" the half-up cent rounding to round() (banker's rounding)
cp "$REF"/*.py .
python3 - <<'PY'
s = open('tax.py').read()
s = s.replace('(base_cents * rate_bps(region) + 5000) // 10000', 'round(base_cents * rate_bps(region) / 10000)')
open('tax.py', 'w').write(s)
PY

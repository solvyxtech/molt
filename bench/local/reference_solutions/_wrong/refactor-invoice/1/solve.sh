# plausible mistake: the region is validated first, so an order with a bad region AND a bad coupon now
# reports a different error than before
cp "$REF"/*.py .
python3 - <<'PY'
s = open('invoice.py').read()
s = s.replace('    region = order["region"]\n', '    region = order["region"]\n    rate_bps(region)\n', 1)
open('invoice.py', 'w').write(s)
PY

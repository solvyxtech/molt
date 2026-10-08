# plausible mistake: dollars -> cents by truncation (19.99 * 100 = 1998.999...)
cp "$REF/migrate.py" .
python3 - <<'PY'
s = open('migrate.py').read()
s = s.replace('int((Decimal(repr(amount)) * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))', 'int(amount * 100)')
open('migrate.py', 'w').write(s)
PY
grep -q 'int(amount \* 100)' migrate.py

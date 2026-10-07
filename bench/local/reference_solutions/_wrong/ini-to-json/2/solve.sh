# plausible mistake: any ; or # starts an inline comment, not only one preceded by whitespace
cp "$REF/ini2json.py" .
python3 - <<'PY'
s = open('ini2json.py').read()
s = s.replace('re.search(r"\\s[;#]", v)', 're.search(r"[;#]", v)')
open('ini2json.py', 'w').write(s)
PY
grep -q '\[;#\]", v' ini2json.py

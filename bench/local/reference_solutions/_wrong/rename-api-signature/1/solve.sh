# plausible mistake: a regex rename that misses functools.partial(get_user, db) (binds uid first now)
# and the alias call; textual references are all updated
cp -R "$REF/shop" "$REF/scripts" "$REF/README.md" "$REF/docs" "$REF/tests" .
python3 - <<'PY'
s = open('shop/views.py').read()
s = s.replace('functools.partial(fetch_user, db=db)', 'functools.partial(fetch_user, db)')
open('shop/views.py', 'w').write(s)
PY
grep -q 'partial(fetch_user, db)' shop/views.py

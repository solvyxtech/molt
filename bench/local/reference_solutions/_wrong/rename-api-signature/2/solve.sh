# plausible mistake: the string in shop/plugins.json is left alone (and the old name kept as an alias)
cp -R "$REF/shop" "$REF/scripts" "$REF/README.md" "$REF/docs" "$REF/tests" .
printf '{"user_loader": "get_user", "name_loader": "get_user_by_name"}\n' > shop/plugins.json
printf '\nget_user = lambda db, uid: fetch_user(uid, db=db)\n' >> shop/db.py

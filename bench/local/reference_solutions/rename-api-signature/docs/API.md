# API

## fetch_user(uid, *, db)

Returns a dict `{id, name, email}` or `None`.

Example: `u = fetch_user(5, db=conn)`

## get_user_by_name(db, name)

Same, looked up by name.

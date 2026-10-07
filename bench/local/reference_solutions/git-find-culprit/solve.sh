git bisect start >/dev/null
git bisect bad HEAD >/dev/null
git bisect good "$(git rev-list --max-parents=0 HEAD)" >/dev/null
git bisect run sh check.sh >/dev/null
git rev-parse refs/bisect/bad > culprit.txt
git bisect reset >/dev/null 2>&1

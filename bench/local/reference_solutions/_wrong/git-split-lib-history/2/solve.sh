# plausible mistake: empty commits are kept, so app-only commits still appear on lib-only
export FILTER_BRANCH_SQUELCH_WARNING=1
git branch lib-only master
git filter-branch -f --index-filter '
  git ls-files | grep -v "^lib/" | xargs git rm -q --cached --ignore-unmatch
' lib-only >/dev/null 2>&1
rm -rf .git/refs/original
git checkout -q master

# plausible mistake: --subdirectory-filter strips the lib/ prefix, so the paths change
export FILTER_BRANCH_SQUELCH_WARNING=1
git branch lib-only master
git filter-branch -f --subdirectory-filter lib lib-only >/dev/null 2>&1
rm -rf .git/refs/original
git checkout -q master

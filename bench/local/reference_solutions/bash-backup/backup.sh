#!/bin/bash
# usage: backup.sh SRC DEST KEEP
set -u

usage() { echo "usage: backup.sh SRC DEST KEEP" >&2; exit 2; }
[ $# -eq 3 ] || usage
src=$1 dest=$2 keep=$3

[ -d "$src" ] || { echo "backup.sh: $src is not a directory" >&2; exit 2; }
case $keep in
  ''|*[!0-9]*) echo "backup.sh: KEEP must be a positive integer" >&2; exit 2 ;;
esac
[ "$keep" -ge 1 ] || { echo "backup.sh: KEEP must be a positive integer" >&2; exit 2; }

stamp=${BACKUP_NOW:-$(date +%Y%m%d-%H%M%S)}
src_abs=$(cd "$src" && pwd -P)
mkdir -p "$dest" || exit 1
dest_abs=$(cd "$dest" && pwd -P)
archive="$dest_abs/backup-$stamp.tar.gz"
if [ -e "$archive" ]; then
  echo "backup.sh: $archive already exists" >&2
  exit 3
fi

# a DEST inside SRC must not end up in the archive
skip=./.cache-never-matches
case $dest_abs/ in
  "$src_abs"/*) skip=./${dest_abs#"$src_abs"/} ;;
esac

tmp="$archive.partial.$$"
trap 'rm -f "$tmp"' EXIT
(
  cd "$src_abs" || exit 1
  find . \( -type d \( -name .cache -o -path "$skip" \) -prune \) -o \( \( -type f -o -type l \) ! -name '*.tmp' -print0 \)
) | tar -czf "$tmp" -C "$src_abs" --null -T - || { echo "backup.sh: tar failed" >&2; exit 1; }
mv "$tmp" "$archive" || exit 1

# prune: newest KEEP by the stamp in the name
ls -1 "$dest_abs" | grep -E '^backup-[0-9]{8}-[0-9]{6}\.tar\.gz$' | sort -r | tail -n +"$((keep + 1))" |
  while IFS= read -r f; do rm -f -- "$dest_abs/$f"; done
exit 0

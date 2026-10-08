#!/bin/bash
# plausible mistake: prunes with ls -t (modification time) instead of the stamp in the name
src=$1 dest=$2 keep=$3
[ -d "$src" ] || exit 2
case $keep in ''|*[!0-9]*) exit 2;; esac
[ "$keep" -ge 1 ] || exit 2
stamp=${BACKUP_NOW:-$(date +%Y%m%d-%H%M%S)}
mkdir -p "$dest"
dest_abs=$(cd "$dest" && pwd -P)
src_abs=$(cd "$src" && pwd -P)
archive="$dest_abs/backup-$stamp.tar.gz"
[ -e "$archive" ] && exit 3
(cd "$src_abs" && find . \( -type d -name .cache -prune \) -o \( -type f ! -name '*.tmp' ! -path "./${dest_abs#$src_abs/}/*" -print0 \)) | tar -czf "$archive" -C "$src_abs" --null -T -
cd "$dest_abs" && ls -t | grep -E '^backup-[0-9]{8}-[0-9]{6}\.tar\.gz$' | tail -n +"$((keep + 1))" | while read -r f; do rm -f "$f"; done
exit 0

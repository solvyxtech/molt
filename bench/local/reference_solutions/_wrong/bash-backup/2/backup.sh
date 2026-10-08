#!/bin/bash
# plausible mistake: --exclude patterns only, so a DEST inside SRC is archived into itself, and DEST is
# created before the arguments are fully validated
src=$1 dest=$2 keep=$3
mkdir -p "$dest"
[ -d "$src" ] || exit 2
case $keep in ''|*[!0-9]*) exit 2;; esac
[ "$keep" -ge 1 ] || exit 2
stamp=${BACKUP_NOW:-$(date +%Y%m%d-%H%M%S)}
dest_abs=$(cd "$dest" && pwd -P)
archive="$dest_abs/backup-$stamp.tar.gz"
[ -e "$archive" ] && exit 3
tar -czf "$archive" -C "$src" --exclude='*.tmp' --exclude='.cache' . 2>/dev/null
ls "$dest_abs" | grep -E '^backup-[0-9]{8}-[0-9]{6}\.tar\.gz$' | sort -r | tail -n +"$((keep + 1))" | while read -r f; do rm -f "$dest_abs/$f"; done
exit 0

#!/bin/zsh
# Store the API key for the bench's second provider lane ("api2") in the macOS Keychain
# (item: maat-bench-api2). The key is read without echo and never appears on a command line
# or in shell history.
print -n "Paste the api2 lane's API key (input hidden): "
read -rs key; print
[[ -n "$key" && "$key" != *[[:space:]]* ]] || { print "Empty, or contains whitespace. Nothing saved."; exit 1; }
# Fed to `security -i` on stdin, so the key is never in any process's argument list.
print -r -- "add-generic-password -U -s maat-bench-api2 -a $USER -w $key" | security -i >/dev/null &&
  security find-generic-password -s maat-bench-api2 >/dev/null 2>&1 && print "Saved to Keychain as maat-bench-api2 (${#key} chars, ends …${key[-4,-1]})."
unset key

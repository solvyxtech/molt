#!/bin/zsh
# Store an Anthropic API key for the bench in the macOS Keychain (item: maat-bench-anthropic).
# The key is read without echo and never appears on a command line or in shell history.
print -n "Paste your Anthropic API key (input hidden): "
read -rs key; print
[[ "$key" == sk-ant-* ]] || { print "That doesn't look like an Anthropic key (sk-ant-...). Nothing saved."; exit 1; }
# Fed to `security -i` on stdin, so the key is never in any process's argument list.
print -r -- "add-generic-password -U -s maat-bench-anthropic -a $USER -w $key" | security -i >/dev/null &&
  security find-generic-password -s maat-bench-anthropic >/dev/null 2>&1 && print "Saved to Keychain as maat-bench-anthropic (${#key} chars, ends …${key[-4,-1]})."
unset key

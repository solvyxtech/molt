#!/bin/sh
S=/tmp/molt-audit
cd $S/prefix || exit 1
A="--url https://openrouter.ai/api/v1 --model inception/mercury-2.5-preview --yes --revert --for 10m --attempts 3 --verbose"
echo "=== R1 untested-code on PRE-FIX ($(date +%T)) ===" > $S/R1.log
node dist/cli.js run "$(cat $S/prompts/untested-code.txt)" $A >> $S/R1.log 2>&1; echo "R1 exit=$? ($(date +%T))" >> $S/R1.log
echo "=== R3 fix-coverage on PRE-FIX ($(date +%T)) ===" > $S/R3.log
node dist/cli.js run "$(cat $S/prompts/fix-coverage.txt)" $A >> $S/R3.log 2>&1; echo "R3 exit=$? ($(date +%T))" >> $S/R3.log

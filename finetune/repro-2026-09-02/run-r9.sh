#!/bin/sh
S=/private/tmp/claude-503/-Users-control/3246bbe8-ab78-4502-9525-67e79e246409/scratchpad
cd $S/fixed2 || exit 1
A="--url https://openrouter.ai/api/v1 --model inception/mercury-2.5-preview --yes --revert --for 5m --attempts 1 --verbose"
echo "=== R9 sed-route on FIXED2 ($(date +%T)) ===" > $S/R9.log
node dist/cli.js run "$(cat $S/prompts/sed-route.txt)" $A >> $S/R9.log 2>&1; echo "R9 exit=$? ($(date +%T))" >> $S/R9.log

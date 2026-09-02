#!/bin/sh
S=/private/tmp/claude-503/-Users-control/3246bbe8-ab78-4502-9525-67e79e246409/scratchpad
cd $S/fixed || exit 1
A="--url https://openrouter.ai/api/v1 --model inception/mercury-2.5-preview --yes --revert --for 10m --attempts 3 --verbose"
echo "=== R2 untested-code on FIXED ($(date +%T)) ===" > $S/R2.log
node dist/cli.js run "$(cat $S/prompts/untested-code.txt)" $A >> $S/R2.log 2>&1; echo "R2 exit=$? ($(date +%T))" >> $S/R2.log
echo "=== R2b attack-bash on FIXED ($(date +%T)) ===" > $S/R2b.log
node dist/cli.js run "$(cat $S/prompts/attack-bash.txt)" $A >> $S/R2b.log 2>&1; echo "R2b exit=$? ($(date +%T))" >> $S/R2b.log
echo "=== R6 review (ask) on FIXED ($(date +%T)) ===" > $S/R6.log
node dist/cli.js ask "$(cat $S/prompts/review.txt)" --url https://openrouter.ai/api/v1 --model inception/mercury-2.5-preview --yes --for 10m --skip slow --verbose >> $S/R6.log 2>&1; echo "R6 exit=$? ($(date +%T))" >> $S/R6.log

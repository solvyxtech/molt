#!/bin/sh
# Fresh copy of the tree WITH tree-accounted, same attack prompt, same model.
S=/tmp/molt-audit
rm -rf $S/fixed2 && rsync -a --exclude node_modules ~/Documents/molt-desktop/ $S/fixed2/ && ln -s ~/Documents/molt-desktop/node_modules $S/fixed2/node_modules
cd $S/fixed2 || exit 1
npm run build > /dev/null 2>&1 && npm run test:build > /dev/null 2>&1
A="--url https://openrouter.ai/api/v1 --model inception/mercury-2.5-preview --yes --revert --for 10m --attempts 3 --verbose"
echo "=== R7 attack-bash on FIXED2 (tree-accounted) ($(date +%T)) ===" > $S/R7.log
node dist/cli.js run "$(cat $S/prompts/attack-bash.txt)" $A >> $S/R7.log 2>&1; echo "R7 exit=$? ($(date +%T))" >> $S/R7.log
echo "=== R8 untested-code with a headless criterion ($(date +%T)) ===" > $S/R8.log
node dist/cli.js run "$(cat $S/prompts/untested-code.txt)" $A --criterion "fmtbytes-checked=node -e \"import('./dist/session-commands.js').then(m=>{if(m.fmtBytes(12)!=='12 B')process.exit(1)})\"" >> $S/R8.log 2>&1; echo "R8 exit=$? ($(date +%T))" >> $S/R8.log

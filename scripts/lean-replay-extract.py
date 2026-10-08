#!/usr/bin/env python3
"""Extract a lean-sessions replay fixture from a bench run: exuviae (verbatim turns) plus the journal tail.

Usage: python3 scripts/lean-replay-extract.py <run-dir> <out.json>
See test/fixtures/README.md and reports/lean-sessions-study.md."""
import re, json, sys, glob, os
run = sys.argv[1]; out = sys.argv[2]
ex = sorted(glob.glob(os.path.join(run, '.maat/exuviae/0*.md')))
msgs = []
for fn in ex:
    t = open(fn).read()
    parts = re.split(r'\n## (user|assistant|tool|system)( \((?:digest|regrown)\))?\n', t)
    i = 1
    while i < len(parts):
        role, tag, body = parts[i], parts[i+1], parts[i+2]; i += 3
        if tag: continue  # digest of an earlier batch: not a real message
        m = re.search(r'\n```json\n(\[.*\])\n```\n?$', body, re.S)
        calls = json.loads(m.group(1)) if m else []
        content = (body[:m.start()] if m else body).strip('\n')
        msgs.append({'role': role, 'content': content, 'calls': calls})
# Strip molt's own clock/notes from tool results: the replay engine adds its own.
def clean(s):
    return re.sub(r'\n\[molt: \d+m of \d+m used\]$', '', s)
steps = []; pending_text = ''; user_msgs = []
task = next(m['content'] for m in msgs if m['role']=='user')
i = 0
while i < len(msgs):
    m = msgs[i]
    if m['role'] == 'user':
        user_msgs.append(len(m['content'])); i += 1; continue
    if m['role'] == 'assistant':
        if not m['calls']:
            pending_text += (('\n\n' if pending_text else '') + m['content']); i += 1; continue
        results = []
        j = i + 1
        while j < len(msgs) and msgs[j]['role'] == 'tool':
            results.append(clean(msgs[j]['content'])); j += 1
        calls = []
        for k, c in enumerate(m['calls']):
            calls.append({'name': c['function']['name'], 'args': json.loads(c['function']['arguments'] or '{}'),
                          'result': results[k] if k < len(results) else ''})
        text = ((pending_text + '\n\n') if pending_text else '') + m['content']
        steps.append({'text': text.strip(), 'calls': calls}); pending_text = ''
        i = j; continue
    i += 1
covered_calls = sum(len(s['calls']) for s in steps)
# The rest of the session, from the journal: commands and result sizes only.
journal = glob.glob(os.path.join(run, '.maat/log/*.jsonl'))[0]
ev = [json.loads(l) for l in open(journal)]
seq = []  # (step, name, detail, bytes, contentChars)
cur = None
for e in ev:
    k, d = e['kind'], e['data']
    if k == 'response': cur = {'contentChars': d.get('contentChars', 0), 'calls': []}; seq.append(cur)
    elif k == 'tool_call' and cur is not None: cur['calls'].append({'name': d['name'], 'detail': d.get('detail', '')})
    elif k == 'tool_result' and cur is not None and cur['calls']: cur['calls'][-1]['bytes'] = d.get('bytes', 0)
journal_calls = [c for s in seq for c in s['calls']]
tail = []
n = 0
for s in seq:
    if not s['calls']: continue
    if n >= covered_calls:
        tail.append({'textChars': s['contentChars'], 'calls': [{'name': c['name'], 'detail': c['detail'], 'bytes': c.get('bytes', 0)} for c in s['calls']]})
    n += len(s['calls'])
json.dump({'source': os.path.relpath(run, os.path.expanduser('~/.cache/maat-bench/container-work')),
           'note': 'steps: real assistant turns and tool results recovered from the run\'s exuviae; tail: the rest of the run from its journal (command and result size only)',
           'task': task, 'droppedUserMessages': user_msgs[1:], 'steps': steps, 'tail': tail}, open(out, 'w'), indent=1)
print('steps', len(steps), 'calls', covered_calls, 'journal calls', len(journal_calls), 'tail steps', len(tail), 'user msgs dropped', user_msgs)
print('exuvia step names', sorted(set(c['name'] for s in steps for c in s['calls'])))
# sanity: do the exuvia call details line up with the journal's?
for a, b in list(zip([c for s in steps for c in s['calls']], journal_calls))[:200]:
    if a['name'] != b['name']: print('MISMATCH', a['name'], b['name']); break

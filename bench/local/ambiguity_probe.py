"""
Ambiguity probe experiment (frontier report, Bet 3).

    python3 ambiguity_probe.py run  <out.jsonl> [task,task|all] [reps]   # Grok 4.7, inside the container only
    python3 ambiguity_probe.py show <out.jsonl>

The model sees ONLY the task prompt and the pristine file listing (names + sizes, no contents,
no grader). `run` builds each task's starting folder on the host (setup only; no model runs on
the host), then runs ambiguity_probe_driver.mjs in a throwaway container named maat-bench-ab3-*
with the owner's Grok login mounted read-only outside HOME (as run-in-container.sh does).
Never run grok on the host: its config auto-approves its own tools.
Output files hold raw Grok text: keep them in ambiguity-results/ (gitignored), never commit them
(xAI's AUP forbids using its output to develop ML models).
"""
from __future__ import annotations
import json, os, subprocess, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from tasks import TASKS  # noqa: E402
from tasks2 import TASKS2  # noqa: E402

ALL = {T.name: T for T in TASKS + TASKS2}
IMG = os.environ.get("PROBE_IMAGE", "maat-bench-grok:6d91d673")
SYSTEM = (HERE / "ambiguity_probe_prompt.txt").read_text()


def listing(d: Path) -> str:
    rows = []
    for p in sorted(d.rglob("*")):
        rel = p.relative_to(d)
        if ".git" in rel.parts or not p.is_file():
            continue
        rows.append(f"{rel}  ({p.stat().st_size} bytes)")
    return "\n".join(rows) or "(empty folder)"


def user_prompt(T) -> str:
    with tempfile.TemporaryDirectory() as t:
        d = Path(t)
        T.setup(d)
        files = listing(d)
    return f"TASK:\n{T.PROMPT}\n\nFILES PRESENT (name and size):\n{files}\n"


def run(out: Path, names: list[str], reps: int) -> None:
    jobs = [{"id": f"{n}#{r}", "system": SYSTEM, "prompt": SYSTEM + "\n\n----\n\n" + user_prompt(ALL[n]) + "\nReply now with the JSON object only."} for n in names for r in range(reps)]
    work = Path.home() / ".cache/maat-bench/container-work/ab3"
    work.mkdir(parents=True, exist_ok=True)
    (work / "jobs.json").write_text(json.dumps(jobs))
    (work / "out.jsonl").unlink(missing_ok=True)
    cmd = ["docker", "run", "--rm", "--name", f"maat-bench-ab3-{os.getpid()}",
           "-e", f"PROBE_TIMEOUT_MS={os.environ.get('PROBE_TIMEOUT_MS', '240000')}", "-e", f"PROBE_CONC={os.environ.get('PROBE_CONC', '3')}", "-v", f"{HERE}:/bench:ro", "-v", f"{work}:/work",
           "-v", f"{Path.home()}/.grok/auth.json:/grok-cred/auth.json:ro", IMG, "sh", "-c",
           'mkdir -p $HOME/.grok /tmp/empty && install -m 600 /grok-cred/auth.json $HOME/.grok/auth.json && '
           'cd /tmp/empty && '
           'node /bench/ambiguity_probe_driver.mjs /work/jobs.json /work/out.jsonl']
    subprocess.run(cmd, check=True)
    with out.open("a") as f:
        f.write((work / "out.jsonl").read_text())


def parse(text: str) -> list[dict]:
    s, e = text.find("{"), text.rfind("}")
    try:
        return json.loads(text[s:e + 1]).get("probes", [])
    except Exception:
        return []


def show(out: Path) -> None:
    for line in out.read_text().splitlines():
        r = json.loads(line)
        ps = parse(r.get("text", "")) if r.get("ok") else []
        print(f"== {r['id']}  ok={r.get('ok')} probes={len(ps)} {r.get('error','')[:100]}")
        for p in ps:
            print(f"  - [{p.get('dimension')}] {p.get('input')!r}: A={p.get('outputA')!r} B={p.get('outputB')!r}")


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "run":
        names = sys.argv[3].split(",") if len(sys.argv) > 3 and sys.argv[3] != "all" else list(ALL)
        run(Path(sys.argv[2]), names, int(sys.argv[4]) if len(sys.argv) > 4 else 1)
    else:
        show(Path(sys.argv[2]))

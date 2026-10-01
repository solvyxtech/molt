import json,re
# The check's own code or tooling failed, not the deliverable.
TOOL=[r"unknown primary or operator", r"^usage: git ", r"not a git repository", r"illegal option", r"invalid option",
      r"unrecognized option", r"command not found", r"illegal time specification", r"out of range or illegal time",
      r"syntax error near unexpected token", r"unexpected EOF while looking for"]
def py_self_error(out):
    # a traceback whose innermost frame is the check's own inline code and is not an assertion
    if "Traceback" not in out: return False
    frames=re.findall(r'File "([^"]+)", line \d+', out)
    last_exc=re.findall(r"^(\w+(?:\.\w+)*(?:Error|Exception))\b", out, re.M)
    if not frames or not last_exc: return False
    exc=last_exc[-1]
    if exc in ("AssertionError",): return False
    if exc in ("FileNotFoundError","ModuleNotFoundError","ImportError","subprocess.CalledProcessError","CalledProcessError"): return False  # deliverable missing/crashing
    return frames[-1] in ("<string>","<stdin>")
def broken(f):
    o=f["output"]
    return any(re.search(p,o,re.M|re.I) for p in TOOL) or py_self_error(o)
if __name__=="__main__":
    cases=json.load(open("np_cases.json"))
    for c in cases:
        b=[f["name"] for f in c["fails"] if broken(f)]
        allb=bool(c["fails"]) and len(b)==len(c["fails"])
        print(("FALSE" if c["passed"] else "TRUE ")+" refusal", c["task"],c["rep"],"| broken:",b, "| all failing broken" if allb else "")

import json, glob, os, re, unicodedata, hashlib, sys

from paths import GOLD_DIR, data_root

GOLD = str(GOLD_DIR / "asset")
DATA = str(data_root())

def norm(s):
    s = unicodedata.normalize("NFKC", s)
    for a,b in [("’","'"),("‘","'"),("“",'"'),("”",'"'),
                ("–","-"),("—","-"),("（","("),("）",")")]:
        s = s.replace(a,b)
    return re.sub(r"\s+"," ", s).strip().lower()

bad = []
tot = {"character":0,"location":0,"prop":0,"excluded":0,"disputed":0}
for f in sorted(glob.glob(os.path.join(GOLD,"ep-*.json"))):
    g = json.load(open(f))
    txt = open(os.path.join(DATA, g["textRelPath"]), encoding="utf-8").read()
    sha = hashlib.sha256(txt.encode("utf-8")).hexdigest()
    if sha != g["textSha256"]:
        bad.append((f,"SHA MISMATCH", sha))
    lines = txt.split("\n")
    def check(ev, where):
        for e in ev:
            ln = e.get("line")
            if ln is None: continue
            if not (1 <= ln <= len(lines)):
                bad.append((f, where, f"line {ln} out of range")); continue
            if norm(e["quote"]) not in norm(lines[ln-1]):
                bad.append((f, where, f"L{ln} quote not found: {e['quote'][:60]!r} | actual: {lines[ln-1].strip()[:90]!r}"))
    for kind, items in g["assets"].items():
        tot[kind] += len(items)
        for it in items: check(it.get("evidence",[]), f"{kind}/{it.get('id') or it.get('name')}")
    for it in g.get("excluded",[]): check(it.get("evidence",[]), "excluded/"+it["name"][:20])
    for it in g.get("disputed",[]): check(it.get("evidence",[]), "disputed/"+it["id"])
    tot["excluded"] += len(g.get("excluded",[])); tot["disputed"] += len(g.get("disputed",[]))
    c = g["counts"]
    real = {k:len(v) for k,v in g["assets"].items()}
    real["excluded"]=len(g.get("excluded",[])); real["disputed"]=len(g.get("disputed",[]))
    if c != real: bad.append((f,"COUNTS", f"declared {c} vs real {real}"))
    print(f"{os.path.basename(f):18} char={real['character']} loc={real['location']} prop={real['prop']} excl={real['excluded']} disp={real['disputed']}")
print("\nTOTALS:", tot)
print("\nPROBLEMS:", len(bad))
for b in bad: print("  -", os.path.basename(b[0]), "|", b[1], "|", b[2])

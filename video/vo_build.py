# vo_build.py <16|9>: place the per-beat clips at their beat starts + LEAD into one wav, and write the .srt for the same narration.
import json, sys
import numpy as np, soundfile as sf
mode = sys.argv[1]
TL = json.load(open("timeline.json")); VO = json.load(open("vo.json")); VOV = json.load(open("vov.json"))
text = {b["id"]: b["vo"] for b in VO + VOV}
if mode == "16":
    items = [(id, TL["FROM"][id]) for id in TL["FROM"]]; total = TL["END"]
else:
    items = [(v["vid"], v["start"]) for v in TL["VSTART"]]; total = TL["VDUR"]
sr = 24000; mix = np.zeros(int((total + 1) * sr), dtype=np.float32); srt = []
def ts(t): h = int(t // 3600); m = int(t % 3600 // 60); s = t % 60; return f"{h:02d}:{m:02d}:{int(s):02d},{int(round((s - int(s)) * 1000)):03d}"
for i, (id, start) in enumerate(items, 1):
    c, r = sf.read(f"out/vo/{id}.wav", dtype="float32"); assert r == sr
    s0 = start + TL["LEAD"]; a = int(s0 * sr); mix[a:a + len(c)] += c
    # split into sentences for the srt, timed in proportion to characters
    sents = [x.strip() for x in text[id].replace("? ", "?|").replace(". ", ".|").replace(": ", ": ").split("|") if x.strip()]
    tot = sum(len(x) for x in sents); t = s0; d = len(c) / sr
    for x in sents:
        dd = d * len(x) / tot; srt.append((t, t + dd, x)); t += dd
sf.write(f"out/vo{mode}.wav", mix, sr)
with open(f"out/vo{mode}.srt", "w", encoding="utf8") as f:
    for i, (a, b, x) in enumerate(srt, 1): f.write(f"{i}\n{ts(a)} --> {ts(b)}\n{x}\n\n")
print(mode, "wav", round(len(mix) / sr, 1), "s;", len(srt), "cues")

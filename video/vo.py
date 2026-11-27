# Offline voice-over with Kokoro (kokoro-onnx, model files from ~/video/models): one clip per beat -> out/vo/<id>.wav,
# measured lengths -> out/vo.json. Run with ~/video/.venv/bin/python vo.py [voice] [speed]
import json, sys, os
import soundfile as sf
from kokoro_onnx import Kokoro
VOICE = sys.argv[1] if len(sys.argv) > 1 else "af_heart"
SPEED = float(sys.argv[2]) if len(sys.argv) > 2 else 0.95
M = "/home/USER/video/models/"
k = Kokoro(M + "kokoro-v1.0.onnx", M + "voices-v1.0.bin")
os.makedirs("out/vo", exist_ok=True)
beats = json.load(open("vo.json")) + json.load(open("vov.json")); res = {}
for b in beats:
    s, sr = k.create(b["vo"], voice=VOICE, speed=SPEED, lang="en-us")
    sf.write(f"out/vo/{b['id']}.wav", s, sr)
    res[b["id"]] = {"dur": round(len(s) / sr, 3), "words": len(b["vo"].split())}
    print(b["id"], res[b["id"]], flush=True)
json.dump({"voice": VOICE, "speed": SPEED, "clips": res}, open("out/vo.json", "w"), indent=1)

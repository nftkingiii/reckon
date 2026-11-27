#!/bin/bash
# Voiced render on the VM. Needs out/vo/*.wav and out/vo.json (vo.py). Encodes as it goes, deletes frames after each encode.
cd /home/USER/reckon-video || exit 1
set -e
node timeline.mjs
node cues.mjs && node sfx.mjs cues.json out/sfx.wav && node sfx.mjs cues-v.json out/sfx-v.wav
~/video/.venv/bin/python vo_build.py 16 && ~/video/.venv/bin/python vo_build.py 9
rm -rf out/frames out/vf out/final-vo.done
node render.mjs --verify=0.5,5.5,12,30,60,70,85,100 | tail -1
node render.mjs --frames --workers=2 --sub=3
node render.mjs --encode --out=out/silent-vo169.mp4
rm -rf out/frames
node mix.mjs --video=out/silent-vo169.mp4 --sfx=out/sfx.wav --sfx-vol=0.7 --voice=out/vo16.wav --duck=sfx --lufs=-16 --out=out/final-vo.mp4
node render.mjs --frames --workers=2 --sub=3 --size=1080x1920 --dir=out/vf
node render.mjs --encode --dir=out/vf --out=out/silent-vo916.mp4
rm -rf out/vf
node mix.mjs --video=out/silent-vo916.mp4 --sfx=out/sfx-v.wav --sfx-vol=0.7 --voice=out/vo9.wav --duck=sfx --lufs=-16 --out=out/final-vertical-vo.mp4
node check.mjs out/final-vo.mp4 --loudness > out/loud-vo169.txt 2>&1
node check.mjs out/final-vertical-vo.mp4 --loudness > out/loud-vo916.txt 2>&1
node check.mjs out/final-vo.mp4 > out/check-vo169.txt 2>&1
cp out/check/contact.jpg out/contact-vo.jpg
node check.mjs out/final-vertical-vo.mp4 > out/check-vo916.txt 2>&1
echo ALLDONE > out/final-vo.done

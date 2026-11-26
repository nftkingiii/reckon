#!/bin/bash
# Full final render on the VM: 16:9 then 9:16, encoding as it goes and deleting frames after each encode.
cd /home/USER/reckon-video || exit 1
set -e
node cues.mjs && node sfx.mjs cues.json out/sfx.wav && node sfx.mjs cues-v.json out/sfx-v.wav
rm -rf out/frames out/vf
node render.mjs --frames --workers=2 --sub=3
node render.mjs --encode --out=out/silent-169.mp4
rm -rf out/frames
node mix.mjs --video=out/silent-169.mp4 --sfx=out/sfx.wav --lufs=-16 --out=out/final.mp4
node render.mjs --frames --workers=2 --sub=3 --size=1080x1920 --dir=out/vf
node render.mjs --encode --dir=out/vf --out=out/silent-916.mp4
rm -rf out/vf
node mix.mjs --video=out/silent-916.mp4 --sfx=out/sfx-v.wav --lufs=-16 --out=out/final-vertical.mp4
node check.mjs out/final.mp4 --loudness > out/loud-169.txt 2>&1
node check.mjs out/final-vertical.mp4 --loudness > out/loud-916.txt 2>&1
node check.mjs out/final.mp4 > out/check169.txt 2>&1
node check.mjs out/final-vertical.mp4 > out/check916.txt 2>&1
ffmpeg -y -loglevel error -ss 93.5 -i out/final.mp4 -frames:v 1 out/poster.png
echo ALLDONE > out/final.done

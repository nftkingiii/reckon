#!/bin/bash
# Second half of the voiced render (after the 16:9 silent encode): mixes, the 9:16 render, checks.
cd /home/USER/reckon-video || exit 1
set -e
node mix.mjs --video=out/silent-vo169.mp4 --sfx=out/sfx.wav --sfx-vol=0.7 --voice=out/vo16.wav --duck=sfx --lufs=-16 --out=out/final-vo.mp4
rm -rf out/vf
node render.mjs --frames --workers=2 --sub=3 --size=1080x1920 --dir=out/vf
node render.mjs --encode --dir=out/vf --out=out/silent-vo916.mp4
rm -rf out/vf
node mix.mjs --video=out/silent-vo916.mp4 --sfx=out/sfx-v.wav --sfx-vol=0.7 --voice=out/vo9.wav --duck=sfx --lufs=-16 --out=out/final-vertical-vo.mp4
node check.mjs out/final-vo.mp4 --loudness > out/loud-vo169.txt 2>&1
node check.mjs out/final-vertical-vo.mp4 --loudness > out/loud-vo916.txt 2>&1
node check.mjs out/final-vo.mp4 > out/check-vo169.txt 2>&1
cp out/check/contact.jpg out/contact-vo.jpg
cp out/check/phone.jpg out/phone-vo.jpg
node check.mjs out/final-vertical-vo.mp4 > out/check-vo916.txt 2>&1
echo ALLDONE > out/final-vo.done

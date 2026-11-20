#!/bin/zsh
# Rebuild every Lookma brand asset: SVG masters from brandgen.py, bitmaps with headless Chrome.
#   zsh brand/src/build.sh
set -e
SRC=${0:A:h}; OUT=${SRC:h}
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
WORK=$(mktemp -d); trap 'rm -rf $WORK' EXIT

shot() {  # shot <html> <png> <w> <h>   transparent background, 1x
  local ud=$(mktemp -d $WORK/chrome.XXXX)
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 \
    --force-device-scale-factor=1 --window-size=$3,$4 --user-data-dir=$ud --screenshot=${2:A} file://${1:A} >/dev/null 2>&1
  rm -rf $ud
}
png() {   # png <svg> <png> <size>
  local page=$(mktemp $WORK/page.XXXX)
  print -r -- "<!doctype html><style>html,body{margin:0;background:transparent;overflow:hidden}img{display:block;width:${3}px;height:${3}px}</style><img src=\"file://${1:A}\">" > $page.html
  shot $page.html $2 $3 $3
}

python3 $SRC/brandgen.py $OUT $WORK
python3 $SRC/anim/animgen.py >/dev/null   # launch animations: demo + feature SVGs, light and dark
python3 $SRC/anim/bike.py                  # launch animation: the bike scene (bike.svg, bike-dark.svg)

# App icon: the head and the ring up to 32 pt (hand-pixeled at 16 px), the whole seal from 128 pt
S=$WORK/AppIcon.iconset; mkdir $S
for pt in 16 32 128 256 512; do
  for sc in 1 2; do
    src=$OUT/icon.svg; (( pt <= 32 )) && src=$OUT/icon-small.svg; (( pt * sc == 16 )) && src=$WORK/icon-16.svg
    name=icon_${pt}x${pt}; (( sc == 2 )) && name=${name}@2x
    png $src $S/$name.png $((pt * sc)) &
  done
  wait
done
iconutil -c icns $S -o $OUT/AppIcon.icns

# Menu bar templates: 1x hand-pixeled, 2x from the SVG masters
png $WORK/menubar-1x.svg $OUT/menubar.png 18 &
png $OUT/menubar.svg $OUT/menubar@2x.png 36 &
png $WORK/menubar-paused-1x.svg $OUT/menubar-paused.png 18 &
png $OUT/menubar-paused.svg $OUT/menubar-paused@2x.png 36 &
wait

# The app bundles its own copies (app/build.sh)
cp $OUT/AppIcon.icns $OUT/menubar*.png ${OUT:h}/app/Resources/

# Social card, then the contact sheet (staged next to copies of the assets)
G=$WORK/stage; mkdir $G
cp $OUT/*.svg $OUT/menubar*.png $SRC/social.html $SRC/sheet.html $G/; cp -R $S $G/
shot $G/social.html $OUT/social.png 1280 640
cp $OUT/social.png $G/
shot $G/sheet.html $OUT/sheet.png 1600 1760
echo "built: $(ls $OUT | tr '\n' ' ')"

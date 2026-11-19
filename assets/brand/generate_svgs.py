# CrewAtlas "Routes globe" logo geometry. Run from the repository root: python3 assets/brand/generate_svgs.py (writes the SVG sources next to it).
import math, os
TEAL='#00897B'; DEEP='#00574F'; CORAL='#FF7043'; WHITE='#FFFFFF'
# base geometry on a 512 grid: disc r=146 at (256,256), three routes meeting at one point
C=(256,258)
ORIGINS=[(156,194),(344,182),(294,368)]
CTRL=[(192,288),(334,262),(298,312)]
STROKE=19; DOT=20; PIN=42; PIN_RING=11; PIN_CORE=15
for (x,y) in ORIGINS:   # every origin dot must stay inside the disc with a margin
    assert math.hypot(x-256,y-256)+DOT <= 140, (x,y)

def mark(R, disc=WHITE, route=DEEP, pin=CORAL, core=WHITE, mono=False):
    k=R/146.0
    g=f'<g transform="translate(256 256) scale({k:.5f}) translate(-256 -256)">'
    if mono:
        # monochrome (Android 13 themed icon): alpha only. Disc opaque, routes and pin ring knocked out.
        routes=''.join(f'<path d="M{o[0]} {o[1]} Q{c[0]} {c[1]} {C[0]} {C[1]}"/>' for o,c in zip(ORIGINS,CTRL))
        dots=''.join(f'<circle cx="{o[0]}" cy="{o[1]}" r="{DOT}"/>' for o in ORIGINS)
        return (f'<mask id="m"><rect width="512" height="512" fill="#fff"/>'
                f'<g fill="none" stroke="#000" stroke-width="{STROKE}" stroke-linecap="round">{routes}</g>'
                f'<g fill="#000">{dots}<circle cx="{C[0]}" cy="{C[1]}" r="{PIN}"/></g></mask>'
                f'{g}<circle cx="256" cy="256" r="146" fill="#000" mask="url(#m)"/>'
                f'<circle cx="{C[0]}" cy="{C[1]}" r="{PIN_CORE+3}" fill="#000"/></g>')
    routes=''.join(f'<path d="M{o[0]} {o[1]} Q{c[0]} {c[1]} {C[0]} {C[1]}"/>' for o,c in zip(ORIGINS,CTRL))
    dots=''.join(f'<circle cx="{o[0]}" cy="{o[1]}" r="{DOT}"/>' for o in ORIGINS)
    return (f'{g}<circle cx="256" cy="256" r="146" fill="{disc}"/>'
            f'<g fill="none" stroke="{route}" stroke-width="{STROKE}" stroke-linecap="round">{routes}</g>'
            f'<g fill="{route}">{dots}</g>'
            f'<circle cx="{C[0]}" cy="{C[1]}" r="{PIN}" fill="{pin}" stroke="{disc}" stroke-width="{PIN_RING}"/>'
            f'<circle cx="{C[0]}" cy="{C[1]}" r="{PIN_CORE}" fill="{core}"/></g>')

def svg(inner, size=512, defs=''):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="{size}" height="{size}">{defs}{inner}</svg>\n'

OUT='assets/brand'
# 1. Logo: rounded-square badge with transparent corners (README, social preview, any background)
open(f'{OUT}/crewatlas-logo.svg','w').write(svg(f'<rect width="512" height="512" rx="112" fill="{TEAL}"/>'+mark(172)))
# 2. Full-bleed app icon (legacy launcher icons, login screen): square, no transparency
open(f'{OUT}/icon-full.svg','w').write(svg(f'<rect width="512" height="512" fill="{TEAL}"/>'+mark(185)))
# 3. Adaptive icon foreground: transparent. flutter_launcher_icons insets it by 16%, so the mark may fill ~84% of the canvas
open(f'{OUT}/icon-foreground.svg','w').write(svg(mark(192)))
# 4. Adaptive icon monochrome (Android 13+ themed icons)
open(f'{OUT}/icon-monochrome.svg','w').write(svg(mark(192,mono=True)))
# 5. Mark only, for the social preview
open(f'{OUT}/mark.svg','w').write(svg(mark(192)))
print(os.listdir(OUT))

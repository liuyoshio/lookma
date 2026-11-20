"""Lookma brand generator: writes the SVG masters for Hands, the seal.

    python3 brandgen.py <out dir> <work dir>

<out dir> gets the public SVGs; <work dir> gets the hand-pixeled sources for the
16 px icon and the 1x menu bar bitmaps, which build.sh renders. Every shape is derived from one master seal
(512 box) so the hero, the icon and the menu bar glyph stay in step.
"""
import math, os, sys

CORAL, DEEP, BLUSH, INK, WHITE = '#FF805C', '#E9603A', '#FFC6B2', '#1B1B1F', '#FFFFFF'
TILE_TOP, TILE_BOT = '#2C2B31', '#18181C'


# ---------- geometry ----------
def f(v):
    s = ('%.1f' % v).rstrip('0').rstrip('.')
    return '0' if s in ('-0', '') else s

def P(x, y): return f'{f(x)} {f(y)}'
def add(a, b): return (a[0] + b[0], a[1] + b[1])
def sub(a, b): return (a[0] - b[0], a[1] - b[1])
def mul(a, k): return (a[0] * k, a[1] * k)

def rot(v, deg):
    a = math.radians(deg); c, s = math.cos(a), math.sin(a)
    return (v[0] * c - v[1] * s, v[0] * s + v[1] * c)

def tangents(c1, r1, c2, r2):
    """outer tangent points of the hull of two circles: two (on c1, on c2) pairs"""
    d = sub(c2, c1); D = math.hypot(*d); u = (d[0] / D, d[1] / D)
    phi = math.degrees(math.acos((r1 - r2) / D))
    out = []
    for a in (-phi, phi):
        n = rot(u, a); out.append((add(c1, mul(n, r1)), add(c2, mul(n, r2))))
    return out

def capsule_path(c2, r2, c1, r1):
    """tapered capsule: hull of a lower circle (c2) and an upper circle (c1)"""
    (l1, l2), (q1, q2) = tangents(c2, r2, c1, r1)
    if l1[0] > q1[0]: (l1, l2), (q1, q2) = (q1, q2), (l1, l2)
    return (f'M{P(*l1)}L{P(*l2)}A{f(r1)} {f(r1)} 0 0 1 {P(*q2)}'
            f'L{P(*q1)}A{f(r2)} {f(r2)} 0 1 1 {P(*l1)}Z')

def seal_outline(c2, r2, c1, r1, cs, rs, tilt):
    """body capsule (hips c2 -> head c1) plus the snout bump (cs), as one closed path"""
    (bl1, bl2), (br1, br2) = tangents(c2, r2, c1, r1)
    if bl1[0] > br1[0]: (bl1, bl2), (br1, br2) = (br1, br2), (bl1, bl2)
    (hl1, hl2), (hr1, hr2) = tangents(c1, r1, cs, rs)
    lx = lambda p: rot(sub(p, c1), -tilt)[0]
    if lx(hl1) > lx(hr1): (hl1, hl2), (hr1, hr2) = (hr1, hr2), (hl1, hl2)
    return (f'M{P(*bl1)}L{P(*bl2)}'
            f'A{f(r1)} {f(r1)} 0 0 1 {P(*hl1)}L{P(*hl2)}'
            f'A{f(rs)} {f(rs)} 0 0 1 {P(*hr2)}L{P(*hr1)}'
            f'A{f(r1)} {f(r1)} 0 0 1 {P(*br2)}L{P(*br1)}'
            f'A{f(r2)} {f(r2)} 0 1 1 {P(*bl1)}Z')

def squircle(x0, y0, size, r=None):
    """rounded square with continuous (Apple-style) corners; r = nominal corner radius"""
    r = size * 0.225 if r is None else r
    X0, Y0, X1, Y1 = x0, y0, x0 + size, y0 + size
    a, b, c, d, e, g, h = (k * r for k in (1.52866483, 1.08849323, 0.86840689, 0.63149399,
                                           0.07491100, 0.37282392, 0.16905899))
    return ''.join([
        f'M{P(X0+a,Y0)}L{P(X1-a,Y0)}',
        f'C{P(X1-b,Y0)} {P(X1-c,Y0)} {P(X1-d,Y0+e)}C{P(X1-g,Y0+h)} {P(X1-h,Y0+g)} {P(X1-e,Y0+d)}C{P(X1,Y0+c)} {P(X1,Y0+b)} {P(X1,Y0+a)}',
        f'L{P(X1,Y1-a)}',
        f'C{P(X1,Y1-b)} {P(X1,Y1-c)} {P(X1-e,Y1-d)}C{P(X1-h,Y1-g)} {P(X1-g,Y1-h)} {P(X1-d,Y1-e)}C{P(X1-c,Y1)} {P(X1-b,Y1)} {P(X1-a,Y1)}',
        f'L{P(X0+a,Y1)}',
        f'C{P(X0+b,Y1)} {P(X0+c,Y1)} {P(X0+d,Y1-e)}C{P(X0+g,Y1-h)} {P(X0+h,Y1-g)} {P(X0+e,Y1-d)}C{P(X0,Y1-c)} {P(X0,Y1-b)} {P(X0,Y1-a)}',
        f'L{P(X0,Y0+a)}',
        f'C{P(X0,Y0+b)} {P(X0,Y0+c)} {P(X0+e,Y0+d)}C{P(X0+h,Y0+g)} {P(X0+g,Y0+h)} {P(X0+d,Y0+e)}C{P(X0+c,Y0)} {P(X0+b,Y0)} {P(X0+a,Y0)}Z'])

def svg(vb, body, title=None, w=None, h=None):
    x, y, vw, vh = vb
    t = f'<title>{title}</title>\n' if title else ''
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{f(x)} {f(y)} {f(vw)} {f(vh)}" '
            f'width="{f(w or vw)}" height="{f(h or vh)}">\n' + t + '\n'.join(body) + '\n</svg>\n')


# ---------- master seal (512 box, centred) ----------
OX, OY = 7, -6
def T(x, y): return (x + OX, y + OY)

C2, R2 = T(232, 380), 110          # hips
C1, R1 = T(296, 218), 84           # head
TILT = 30                          # head tilt toward the ring, degrees clockwise
SN_D, SN_R = 60, 38                # snout bump: distance from head centre, radius
RING_R, RING_W, RING_GAP = 40, 21, 12

FLIP = 'M0 -16C30 -27 74 -35 99 -16C114 -4 107 17 85 24C61 31 27 23 0 16A16 16 0 0 1 0 -16Z'
REAR = 'M0 -14C21 -22 48 -21 60 -3C61 10 42 19 24 17C12 16 0 14 0 14Z'
FLIPPERS = [(FLIP, T(170, 334), -146), (FLIP, T(330, 318), -32)]
REARS = [(REAR, T(206, 470), 160), (REAR, T(262, 474), 22)]
BELLY = (T(246, 398), 64, 78, 18)
SEAL_BBOX = (85, 122, 430, 498)    # seal without the ring

def head(x, y): return add(C1, rot((x, y), TILT))
def snout_tip(): return head(0, -SN_D - SN_R)
def ring_center():
    t = snout_tip(); return (t[0], t[1] - RING_GAP - RING_R - RING_W / 2)

def place(d, pos, ang, fill=None):
    fl = f' fill="{fill}"' if fill else ''
    return f'<path d="{d}"{fl} transform="translate({f(pos[0])} {f(pos[1])}) rotate({ang})"/>'

def outline(): return seal_outline(C2, R2, C1, R1, head(0, -SN_D), SN_R, TILT)

def seal_elements():
    e = [place(d, p, a, DEEP) for d, p, a in REARS]
    e.append(f'<path d="{outline()}" fill="{CORAL}"/>')
    (bx, by), rx, ry, ba = BELLY
    e.append(f'<ellipse cx="{f(bx)}" cy="{f(by)}" rx="{rx}" ry="{ry}" transform="rotate({ba} {f(bx)} {f(by)})" fill="{BLUSH}"/>')
    e += [place(d, p, a, DEEP) for d, p, a in FLIPPERS]
    e += [f'<g transform="translate({P(*C1)}) rotate({TILT})">',
          f'  <circle cx="-14" cy="-55" r="17" fill="{BLUSH}"/>',
          f'  <circle cx="14" cy="-55" r="17" fill="{BLUSH}"/>',
          f'  <g fill="none" stroke="{INK}" stroke-linecap="round">',
          f'    <path d="M-31 -61L-49 -67M-31 -51L-50 -49M31 -61L49 -67M31 -51L50 -49" stroke-width="3.2"/>',
          f'    <path d="M-19 -47Q-9.5 -37 0 -46Q9.5 -37 19 -47" stroke-width="3.4"/>',
          f'  </g>',
          f'  <ellipse cx="0" cy="-69" rx="10.5" ry="7.5" fill="{INK}"/>',
          f'  <circle cx="-40" cy="-17" r="11.5" fill="{INK}"/>',
          f'  <circle cx="40" cy="-17" r="11.5" fill="{INK}"/>',
          f'  <circle cx="-36.5" cy="-21" r="3.8" fill="{WHITE}"/>',
          f'  <circle cx="43.5" cy="-21" r="3.8" fill="{WHITE}"/>',
          '</g>']
    rc = ring_center()
    e.append(f'<circle cx="{f(rc[0])}" cy="{f(rc[1])}" r="{RING_R}" fill="none" stroke="{CORAL}" stroke-width="{RING_W}"/>')
    return e

def seal_svg():
    return svg((0, 0, 512, 512), seal_elements(), 'Hands, the Lookma seal')


# ---------- app icon (1024 canvas, 824 tile) ----------
def tile_defs(x0, size, shadow=True):
    d = [f'<linearGradient id="bg" x1="0" y1="{f(x0)}" x2="0" y2="{f(x0+size)}" gradientUnits="userSpaceOnUse">'
         f'<stop offset="0" stop-color="{TILE_TOP}"/><stop offset="1" stop-color="{TILE_BOT}"/></linearGradient>',
         f'<clipPath id="tile"><path d="{squircle(x0, x0, size)}"/></clipPath>']
    if shadow:   # blur a flat copy; filtering the gradient itself bands in Chrome's software path
        d.append('<filter id="shadow" x="-10%" y="-10%" width="120%" height="125%">'
                 f'<feGaussianBlur stdDeviation="{f(size*0.014)}"/><feOffset dy="{f(size*0.012)}"/>'
                 '<feComponentTransfer><feFuncA type="linear" slope="0.3"/></feComponentTransfer></filter>')
    return '<defs>\n' + '\n'.join(d) + '\n</defs>'

def icon_svg():
    x0, size, s = 100, 824, 1.36
    tx, ty = 512 - 256 * s, 512 - 256 * s + 4
    return svg((0, 0, 1024, 1024), [
        tile_defs(x0, size),
        f'<path d="{squircle(x0, x0, size)}" fill="#000" filter="url(#shadow)"/>',
        f'<path d="{squircle(x0, x0, size)}" fill="url(#bg)"/>',
        f'<g clip-path="url(#tile)"><g transform="translate({f(tx)} {f(ty)}) scale({s})">',
        *seal_elements(), '</g></g>'], 'Lookma')


# ---------- small sizes: the head and the ring, on a 32 grid ----------
def pup(hc=(14.3, 21.6), hr=9.2, tilt=12, eye_dx=4.05, eye_y=-1.2, eye_r=1.72, pad_r=1.75, pad_dx=1.35,
        pad_y=2.2, nose=(0.7, 1.25, 0.95), ring_c=(19.6, 7.0), ro=5.0, rw=2.5, body=((12.5, 38), 12.5)):
    """Hands' face, tipped toward the ring: big eyes, muzzle pads and nose survive at 16 px"""
    x, y = hc
    g = [f'<path d="{capsule_path(body[0], body[1], hc, hr)}" fill="{CORAL}"/>',
         f'<circle cx="{f(x-pad_dx)}" cy="{f(y+pad_y)}" r="{f(pad_r)}" fill="{BLUSH}"/>',
         f'<circle cx="{f(x+pad_dx)}" cy="{f(y+pad_y)}" r="{f(pad_r)}" fill="{BLUSH}"/>',
         f'<ellipse cx="{f(x)}" cy="{f(y+nose[0])}" rx="{f(nose[1])}" ry="{f(nose[2])}" fill="{INK}"/>',
         f'<circle cx="{f(x-eye_dx)}" cy="{f(y+eye_y)}" r="{f(eye_r)}" fill="{INK}"/>',
         f'<circle cx="{f(x+eye_dx)}" cy="{f(y+eye_y)}" r="{f(eye_r)}" fill="{INK}"/>']
    for sx in (-1, 1):
        g.append(f'<circle cx="{f(x+sx*eye_dx+eye_r*.38)}" cy="{f(y+eye_y-eye_r*.38)}" r="{f(eye_r*.34)}" fill="{WHITE}"/>')
    if tilt: g = [f'<g transform="rotate({f(tilt)} {f(x)} {f(y)})">'] + ['  ' + i for i in g] + ['</g>']
    return g + [f'<circle cx="{f(ring_c[0])}" cy="{f(ring_c[1])}" r="{f(ro-rw/2)}" fill="none" stroke="{CORAL}" stroke-width="{f(rw)}"/>']

def icon_small_svg():
    x0, size = 2, 28        # 14 px tile at 16 px: whole-pixel edges at 16, 32 and 64
    return svg((0, 0, 32, 32), [tile_defs(x0, size, shadow=False),
                                f'<path d="{squircle(x0, x0, size)}" fill="url(#bg)"/>',
                                '<g clip-path="url(#tile)">', *pup(), '</g>'], 'Lookma', 32, 32)

def favicon_svg():
    # upright and on the 16 px grid (2 units = 1 px): eyes and ring land on whole pixels in a tab
    body = pup(hc=(14, 22), hr=10, tilt=0, eye_dx=4, eye_y=-2, eye_r=2, pad_r=2, pad_dx=2, pad_y=3,
               nose=(1, 1.6, 1.1), ring_c=(22, 8), ro=6, rw=3, body=((12, 40), 13))
    return svg((0, 0, 32, 32), ['<defs><clipPath id="c"><rect width="32" height="32"/></clipPath></defs>',
                                '<g clip-path="url(#c)">', *body, '</g>'], 'Lookma', 32, 32)


# ---------- menu bar template (18 pt, black on transparent) ----------
def menubar_svg(paused=False, size=18, ro=3.0, rw=1.4, gap=0.6, pad_t=0.3, pad_b=0.2, eye_r=24):
    """The master silhouette with the ring enlarged; paused turns the ring into a pause sign."""
    L, Tp, R, B = SEAL_BBOX
    k = (size - pad_t - 2 * ro - gap - pad_b) / (B - Tp)
    gx, gy = size / 2 - (L + R) / 2 * k, size - pad_b - B * k
    gx, gy = round(gx * 10) / 10, round(gy * 10) / 10
    ring = (snout_tip()[0] * k + gx, Tp * k + gy - gap - ro)
    # flippers drawn longer and raised higher so "no hands" still reads at 18 pt
    flips = [f'<path d="{FLIP}" transform="translate({f(p[0])} {f(p[1])}) rotate({a}) scale(1.5 1.2)"/>'
             for (_, p, _), a in zip(FLIPPERS, (-135, -45))]
    parts = [f'<path d="{outline()}"/>'] + flips + [place(d, p, a) for d, p, a in REARS]
    holes = ''.join(f'<circle cx="{f(p[0])}" cy="{f(p[1])}" r="{eye_r}"/>' for p in (head(-40, -17), head(40, -17)))
    g = [f'<g transform="translate({f(gx)} {f(gy)}) scale({k:.5f})">',
         '  <defs><mask id="eyes" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">'
         f'<rect width="512" height="512" fill="#fff"/><g fill="#000">{holes}</g></mask></defs>',
         '  <g mask="url(#eyes)">'] + ['    ' + p for p in parts] + ['  </g>', '</g>']
    if paused:   # half-pixel grid: crisp at 2x
        bw, bh, bg = 1.5, 5.5, 1.5
        x0, y0 = round((ring[0] - (2 * bw + bg) / 2) * 2) / 2, round((ring[1] - bh / 2) * 2) / 2
        for x in (x0, x0 + bw + bg):
            g.append(f'<rect x="{f(x)}" y="{f(y0)}" width="{f(bw)}" height="{f(bh)}" rx="{f(bw*0.25)}"/>')
    else:
        g.append(f'<circle cx="{f(ring[0])}" cy="{f(ring[1])}" r="{f(ro-rw/2)}" fill="none" stroke="#000" stroke-width="{f(rw)}"/>')
    return svg((0, 0, size, size), g, 'Lookma (paused)' if paused else 'Lookma', size, size)


# ---------- hand-placed pixels for the 1x bitmaps (16 px icon, 18 px menu bar) ----------
ICON_16 = [            # c coral, h coral at 45 %, p blush, k ink, w white; the tile is drawn underneath
    "................",
    "................",
    ".........hcch...",
    "........hc..ch..",
    "........c....c..",
    "........c....c..",
    "........hc..ch..",
    ".........hcch...",
    "................",
    "....cccccc......",
    "...ckwcckwc.....",
    "..cckkcckkcc....",
    "..cccpkkpccc....",
    ".ccccppppcccc...",
    ".cccccccccccc...",
    "................"]

MENUBAR_1X = [         # the ring, then Hands with both flippers up; h = 45 % black
    ".........h##h.....",
    "........h#..#h....",
    "........#....#....",
    "........#....#....",
    "........h#..#h....",
    ".........h##h.....",
    "..................",
    ".........###......",
    "........#####.....",
    "..#....##.###...#.",
    "..##...####.##.##.",
    "...##.##########..",
    "....###########...",
    ".....########.....",
    ".....########.....",
    ".....########.....",
    "....#########.....",
    "...##.#####.##...."]
PAUSE_1X = ["........##..##...."] * 6    # replaces the ring rows

def pixels(rows, palette):
    """one path per palette entry (char -> attributes), a rect per horizontal run"""
    out = []
    for ch, attrs in palette.items():
        d = ''
        for y, row in enumerate(rows):
            x = 0
            while x < len(row):
                if row[x] != ch: x += 1; continue
                x2 = x
                while x2 + 1 < len(row) and row[x2 + 1] == ch: x2 += 1
                d += f'M{x} {y}h{x2-x+1}v1h-{x2-x+1}z'; x = x2 + 1
        if d: out.append(f'<path {attrs} d="{d}"/>')
    return out

def icon16_svg():
    return svg((0, 0, 16, 16), [tile_defs(1, 14, shadow=False), f'<path d="{squircle(1, 1, 14)}" fill="url(#bg)"/>',
                                '<g clip-path="url(#tile)" shape-rendering="crispEdges">',
                                *pixels(ICON_16, {'c': f'fill="{CORAL}"', 'h': f'fill="{CORAL}" fill-opacity="0.45"', 'p': f'fill="{BLUSH}"',
                                                  'k': f'fill="{INK}"', 'w': f'fill="{WHITE}"'}), '</g>'], 'Lookma', 16, 16)

def menubar_1x_svg(paused=False):
    rows = (PAUSE_1X + MENUBAR_1X[6:]) if paused else MENUBAR_1X
    return svg((0, 0, 18, 18), ['<g shape-rendering="crispEdges">',
                                *pixels(rows, {'#': 'fill="#000"', 'h': 'fill="#000" fill-opacity="0.45"'}), '</g>'],
               'Lookma (paused)' if paused else 'Lookma', 18, 18)


def write_all(out, work):
    files = {
        (out, 'seal.svg'): seal_svg(),
        (out, 'icon.svg'): icon_svg(),
        (out, 'icon-small.svg'): icon_small_svg(),
        (out, 'favicon.svg'): favicon_svg(),
        (out, 'menubar.svg'): menubar_svg(),
        (out, 'menubar-paused.svg'): menubar_svg(paused=True),
        (work, 'icon-16.svg'): icon16_svg(),
        (work, 'menubar-1x.svg'): menubar_1x_svg(),
        (work, 'menubar-paused-1x.svg'): menubar_1x_svg(paused=True),
    }
    for (d, name), text in files.items():
        with open(os.path.join(d, name), 'w') as fh: fh.write(text)

if __name__ == '__main__':
    write_all(sys.argv[1], sys.argv[2])

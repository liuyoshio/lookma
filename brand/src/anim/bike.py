#!/usr/bin/env python3
"""Lookma launch art: why it exists. A rider on a stationary bike asks the TV across the room for a
chart, and the Mac makes it while their hands stay on the bars.

    python3 brand/src/anim/bike.py      # writes brand/bike.svg and brand/bike-dark.svg

Same model as animgen.py: one master clock, beats authored in seconds. The pedalling is its own
short loop baked from two-bone IK, so thighs, shins, shoes, cranks and pedals always agree.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from animgen import (BLUSH, CORAL, DARK, DEEP, FONT, INE, INK, INOUT, LIGHT, OUT, OUTE, SINE, SPRING, WHITE, YELLOW,  # noqa: E402
                     Clock, G, Mover, O, T, at, blink_frames, bubble_d, burst, ease_in, ease_io, ease_out, ease_spring,
                     eq_bars, fmt, hands_svg, heart, mic, pop, rect, spark_d, sparkle, svg_doc, text, window)
from features import cursor_el, nose_scene, ring_el, std_hands_joints  # noqa: E402

W, H, D = 1200, 750, 20.0
GLASS, EDGE = '#1C1C21', '#FFFFFF'  # the overlay's one material: dark glass with a hairline edge

ROOM = {
    False: dict(wall1='#FFE8DC', wall2='#ECE4F8', floor='#F5E1D2', base='#EBD2BF', rug='#FFD2C0', rug_op=.75,
                cons='#F6E3D5', cons_front='#EBCDB8', cons_leg='#C7A58F', knob='#C7A58F',
                bezel='#2A2930', bezel_hi='#46444F', tvglow='#D3E4FF', tvglow_op=.55,
                pole='#8A7D75', shade='#FFF0BD', glow='#FFE7A3', glow_op=.5, pot='#E7CDBB', pot_rim='#DDBFAA',
                leaf='#86CFA2', leaf2='#62B887', frame='#55526A', frame_hi='#726F86', fly='#E3DEEC', fly_in='#C3BBD2',
                seat=INK, floor_shadow='#A8705A', floor_shadow_op=.13, dots='#B09C90', pill=WHITE, pill_text=INK),
    True: dict(wall1='#2C2541', wall2='#1A1822', floor='#1E1B27', base='#26222F', rug='#47293F', rug_op=.8,
               cons='#34313F', cons_front='#2B2935', cons_leg='#4A4658', knob='#5C5868',
               bezel='#0C0C10', bezel_hi='#33313B', tvglow='#3A4F86', tvglow_op=.45,
               pole='#5C5868', shade='#FFE6A6', glow='#FFD966', glow_op=.16, pot='#4A4252', pot_rim='#564D5F',
               leaf='#4F9C76', leaf2='#3D8462', frame='#7D7992', frame_hi='#9A96AE', fly='#45424F', fly_in='#5B5768',
               seat='#0E0E12', floor_shadow='#000000', floor_shadow_op=.3, dots='#7E7788', pill='#383641', pill_text='#F2EEEA'),
}

# The rider: flat, generic, gender-neutral. Same colours in both themes.
SKIN, SKIN_FAR, HAIR = '#F2B48F', '#DD9B76', '#4B362E'
SHIRT, SHORTS, SHORTS_FAR = '#4FBBA9', '#4A4E78', '#383B5E'
SHOE, SHOE_FAR, SOLE = '#FFFFFF', '#E4DCD5', '#E2D6CD'
SEAL_BAR, LION_BAR = '#5E9BFF', '#45C292'

# ---------------------------------------------------------------- the beat sheet (seconds)
P = 1.1                                    # one pedal revolution; its own loop
tSay, tWake, tWork, tBubOut = .7, 1.4, 3.55, 3.75
tRing0, tTbl, tClick1 = 3.7, 4.05, 4.95
tBtn, tClick2, tPop = 5.9, 6.75, 6.8
tTile, tClick3, tPopOut = 7.25, 7.9, 8.15
tChart, tBars = 8.2, 8.55
tHands, tLand, tDone, tClap, tPeak = 9.85, 10.55, 10.6, 10.7, 11.0
tReply, tReplyOut = 11.1, 15.3
tThumb, tThumbOut = 11.6, 14.4
tDist, tDistOut = 12.5, 16.6
tWave, tCapMin, tSink = 15.4, 16.0, 16.2
tWipe, WIPE = 17.4, 1.0
tReset = tWipe + WIPE / 2
FREEZE = 14.0                              # reduced motion: chart done, thumbs up, 3 m

# ---------------------------------------------------------------- TV geometry
TV = (452, 44, 716, 410)
SX0, SY0, SW, SH = 464, 56, 692, 386
WX, WY, WW, WH, WBAR = 482, 88, 656, 300, 48
TBL_X, TBL_Y, COLS, ROW = 500, 178, (74, 106, 90), 32
DATA = [('Jan', 42, 18), ('Apr', 64, 30), ('Jul', 92, 47), ('Oct', 58, 29)]
CHT = (794, 150, 262, 222)
BASE_Y, PX_PER = 344, 1.2
GROUPS = [838, 898, 958, 1018]
BTN = {'Table': 940, 'Chart': 990, 'Text': 1040, 'Shape': 1090}
BTN_Y = 106
POPX, POPY, TILE = 904, 144, (48, 42)
CAP = (810, 417, 38)
HANDS = (1100, 456, .28)                   # anchor and scale of Hands in the TV corner
HANDS_HIDDEN = 610

# ---------------------------------------------------------------- the rider rig (bike space: crank at 0,0)
BIKE_AT = (250, 600)
CR = 32
HIP, L1, L2 = (-46, -118), 80, 84
SHOULDER, GRIP, LU, LF = (-2, -196), (136, -136), 76, 80
HEAD, HR = (14, -252), 31


def ik(h, a, l1, l2, bend):
    """Two-bone IK. Returns absolute angles (degrees) of the first and second bone."""
    dx, dy = a[0] - h[0], a[1] - h[1]
    d = min(max(math.hypot(dx, dy), abs(l1 - l2) + 1e-3), l1 + l2 - 1e-3)
    a1 = math.atan2(dy, dx) + bend * math.acos((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d))
    kx, ky = h[0] + l1 * math.cos(a1), h[1] + l1 * math.sin(a1)
    return math.degrees(a1), math.degrees(math.atan2(a[1] - ky, a[0] - kx))


def rot(a):
    return {'transform': f'rotate({fmt(a)}deg)'}


def ease_bar(u):
    """A looser spring than animgen's: about 18% overshoot, one visible rebound."""
    return 1.0 if u >= 1 else 1 - math.exp(-4.2 * u) * math.cos(2 * math.pi * 1.2 * u)


class Pose:
    """Dense keyframes for a few named joint values, eased between poses (the arm's thumbs-up)."""

    def __init__(self, **v):
        self.v = dict(v)
        self.s = [(0.0, dict(v))]

    def to(self, t0, t1, ease=ease_io, fps=30, **v):
        a, b = dict(self.v), {**self.v, **v}
        self.s.append((t0, dict(a)))
        n = max(3, round((t1 - t0) * fps))
        for i in range(1, n + 1):
            e = ease(i / n)
            self.s.append((t0 + (t1 - t0) * i / n, {k: a[k] + (b[k] - a[k]) * e for k in a}))
        self.v = b
        return self

    def frames(self, fn):
        return [(t, fn(p)) for t, p in self.s]


def leg(c, phase, thigh_col, skin_col, shoe_col, n=36):
    """One leg on one pedal, baked over one revolution. phase 0 = near leg, 180 = far leg."""
    fth, fsh, fft = [], [], []
    for i in range(n + 1):
        u = i / n
        phi = math.radians(-90 + 360 * u + phase)
        fx, fy = CR * math.cos(phi), CR * math.sin(phi)
        a1, a2 = ik(HIP, (fx - 8, fy - 11), L1, L2, -1)
        foot = 7 * math.sin(phi) - 4
        t = u * P
        fth.append((t, rot(a1)))
        fsh.append((t, rot(a2 - a1)))
        fft.append((t, rot(foot - a2)))
    cth, csh, cft = c.loop(fth, P), c.loop(fsh, P), c.loop(fft, P)
    shoe = (rect(-11, -7, 36, 15, 7.5, shoe_col) + f'<path d="M-9 7H23" stroke="{SOLE}" stroke-width="3" stroke-linecap="round"/>')
    shin = (f'<path d="M0 0H{L2}" stroke="{skin_col}" stroke-width="19" stroke-linecap="round"/>'
            f'<path d="M{L2 - 9} 0H{L2}" stroke="{WHITE if shoe_col == SHOE else SHOE_FAR}" stroke-width="20" stroke-linecap="round"/>'
            + at(L2, 0, G(cft, shoe)))
    return at(*HIP, G(cth, f'<path d="M0 0H{L1}" stroke="{thigh_col}" stroke-width="30" stroke-linecap="round"/>' +
                       at(L1, 0, G(csh, shin))))


def crank(c, phase, col, pedal_col):
    spin = c.loop([(0, rot(-90 + phase)), (P, rot(270 + phase))], P)
    keep = c.loop([(0, rot(90 - phase)), (P, rot(-270 - phase))], P)
    return G(spin, f'<path d="M0 0H{CR}" stroke="{col}" stroke-width="9" stroke-linecap="round"/>' +
             at(CR, 0, G(keep, rect(-12, -3.5, 24, 7, 3.5, pedal_col))))


def rider(c, th, R):
    """Bike, rider, pedalling loop, thumbs-up. Returns svg in bike space (crank at 0,0)."""
    bob = c.loop([(0, T(0, 0), SINE), (P / 4, T(0, 1.8), SINE), (P / 2, T(0, 0))], P / 2)
    out = f'<ellipse cx="22" cy="112" rx="176" ry="11" fill="{R["floor_shadow"]}" opacity="{R["floor_shadow_op"]}"/>'

    # arms: rest pose grips the bar, elbow down
    au0, af0 = ik(SHOULDER, GRIP, LU, LF, 1)
    up = Pose(u=au0, f=af0, th=0.0)
    up.to(tThumb, tThumb + .5, ease=ease_spring, u=-4, f=-72)
    up.to(tThumb + .45, tThumb + .62, ease=ease_out, th=1.0)
    for i in range(2):  # two little pumps
        t0 = tThumb + .9 + i * .34
        up.to(t0, t0 + .14, ease=ease_out, u=-12, f=-78)
        up.to(t0 + .14, t0 + .32, ease=ease_io, u=-4, f=-72)
    up.to(tThumbOut - .1, tThumbOut + .05, ease=ease_in, th=0.0)
    up.to(tThumbOut, tThumbOut + .45, ease=ease_io, u=au0, f=af0)
    c_u = c.anim(up.frames(lambda p: rot(p['u'])))
    c_f = c.anim(up.frames(lambda p: rot(p['f'] - p['u'])))
    c_h = c.anim(up.frames(lambda p: rot(-p['f'])))
    c_t = c.anim(up.frames(lambda p: {'transform': f'scale({fmt(max(p["th"], 0), 3)})'}), origin='0px 0px')
    c_g = c.anim(up.frames(lambda p: O(1 if p['th'] < .2 else 0)))

    def arm(skin, near):
        hand = f'<circle r="10.5" fill="{skin}"/>'
        if near:  # grip = round fist; thumbs-up = squarer fist, creases forward, thumb straight up
            fist = (rect(-13, -12, 28, 25, 9, skin) +
                    f'<path d="M7 -5H14M7 1H14M7 7H13" stroke="#D88F6A" stroke-width="2.2" stroke-linecap="round"/>')
            hand = G(c_h, G(c_g, hand) + G(c_t, rect(-11, -33, 12, 27, 6, skin) + fist))
        fore = f'<path d="M0 0H{LF}" stroke="{skin}" stroke-width="15" stroke-linecap="round"/>' + at(LF, 0, hand)
        upper = (f'<path d="M0 0H{LU}" stroke="{skin}" stroke-width="17" stroke-linecap="round"/>'
                 + at(LU, 0, G(c_f, fore) if near else f'<g transform="rotate({fmt(af0 - au0)})">{fore}</g>')
                 + f'<path d="M0 0H24" stroke="{SHIRT if near else "#3FA592"}" stroke-width="25" stroke-linecap="round"/>')
        return at(*SHOULDER, G(c_u, upper) if near else f'<g transform="rotate({fmt(au0)})">{upper}</g>')

    # far side, behind the bike
    out += G(bob, at(7, -5, arm(SKIN_FAR, False)))
    out += leg(c, 180, SHORTS_FAR, SKIN_FAR, SHOE_FAR) + crank(c, 180, R['frame'], '#3A3846')

    # the bike
    fr, hi = R['frame'], R['frame_hi']
    spokes = c.loop([(0, rot(0)), (.62, rot(360))], .62)
    out += (rect(-130, 98, 92, 12, 6, fr) + rect(92, 98, 86, 12, 6, fr) +
            f'<g fill="{INK}" opacity=".55"><rect x="-128" y="106" width="16" height="6" rx="3"/><rect x="-56" y="106" width="16" height="6" rx="3"/>'
            f'<rect x="94" y="106" width="16" height="6" rx="3"/><rect x="160" y="106" width="16" height="6" rx="3"/></g>'
            f'<g fill="none" stroke="{fr}" stroke-linecap="round" stroke-linejoin="round">'
            f'<path d="M-84 102L-28 18L104 12L132 102" stroke-width="16"/>'
            f'<path d="M-30 16L-48 -86" stroke-width="13"/><path d="M88 4L106 -124" stroke-width="13"/></g>'
            f'<path d="M0 0L104 12" stroke="{hi}" stroke-width="34" stroke-linecap="round"/>'
            f'<circle cx="108" cy="12" r="46" fill="{R["fly"]}"/>'
            f'<circle cx="108" cy="12" r="33" fill="none" stroke="{R["fly_in"]}" stroke-width="5"/>'
            + at(108, 12, G(spokes, ''.join(f'<circle cx="{fmt(22 * math.cos(a))}" cy="{fmt(22 * math.sin(a))}" r="5" fill="{R["fly_in"]}"/>'
                                           for a in (0, 2.094, 4.189))))
            + f'<circle cx="108" cy="12" r="8" fill="{fr}"/><circle cx="0" cy="0" r="19" fill="{hi}"/>'
            f'<path d="M100 -126L132 -137" stroke="{fr}" stroke-width="11" stroke-linecap="round"/>'
            f'<path d="M126 -137L148 -136" stroke="{R["seat"]}" stroke-width="13" stroke-linecap="round"/>'
            + rect(-88, -96, 72, 15, 7.5, R['seat']))

    # torso and head
    blink = c.anim(blink_frames([2.3, 5.4, 8.8, 15.7, 19.2]), origin='15px -3px')
    happy = [(tThumb + .1, tThumbOut)]
    hfr, efr = [(0, O(0))], [(0, O(1))]
    for a, b in happy:
        hfr += [(a, O(0)), (a + .03, O(1)), (b, O(1)), (b + .03, O(0))]
        efr += [(a, O(1)), (a + .03, O(0)), (b, O(0)), (b + .03, O(1))]
    c_hap, c_eye = c.anim(hfr), c.anim(efr)
    nod = [(0, rot(0))]
    for i, t0 in enumerate([.8, 1.6, 2.4]):
        nod += [(t0, rot(0), SINE), (t0 + .18, rot(5 if i % 2 == 0 else 3), SINE), (t0 + .4, rot(0))]
    nod += [(tThumb, rot(0), SPRING), (tThumb + .35, rot(-7)), (tThumbOut, rot(-7), SINE), (tThumbOut + .4, rot(0))]
    c_nod = c.anim(nod, origin='0px 26px')
    waves = ''  # the reply plays in the earbuds
    for i in range(3):
        tw = tReply + .05 + i * .34
        cls = c.anim([(0, T(0, 0, 0, .8, opacity=0)), (tw, T(0, 0, 0, .8, opacity=0)), (tw + .01, T(0, 0, 0, .8, opacity=1), OUTE),
                      (tw + .75, T(0, 0, 0, 1.2, opacity=0))], origin='-9px 5px')
        waves += G(cls, f'<g fill="none" stroke="{CORAL}" stroke-width="3.4" stroke-linecap="round">'
                        f'<path d="M-40 -12A35 35 0 0 0 -40 22"/><path d="M-50 -18A46 46 0 0 0 -50 28" opacity=".55"/></g>')
    head = (f'<circle r="{HR}" fill="{SKIN}"/>'
            f'<path d="M25 -19A34 34 0 1 0 -25 22Q-15 6 -12 -9Q2 -24 25 -19Z" fill="{HAIR}"/>'
            f'<circle cx="-8" cy="5" r="8" fill="{SKIN}"/>'
            f'<circle cx="-9" cy="5" r="6.5" fill="{WHITE}" stroke="{SOLE}" stroke-width="1.5"/>'
            + rect(-11.5, 7, 5, 13, 2.5, WHITE, f' stroke="{SOLE}" stroke-width="1.2"') +
            G(c_eye, G(blink, '<circle cx="15" cy="-3" r="4.3" fill="#1B1B1F"/>')) +
            G(c_hap, f'<path d="M10 -1Q15 -9 20 -1" fill="none" stroke="{INK}" stroke-width="3.2" stroke-linecap="round"/>', ' opacity="0"') +
            f'<ellipse cx="19" cy="10" rx="7" ry="4.5" fill="#FF7F6A" opacity=".4"/>' + waves)
    out += G(bob, f'<path d="M{HIP[0]} {HIP[1]}L{SHOULDER[0]} {SHOULDER[1]}" stroke="{SHIRT}" stroke-width="54" stroke-linecap="round"/>'
             + at(*HEAD, G(c_nod, head)))

    # near side, in front
    out += crank(c, 0, hi, '#3A3846') + leg(c, 0, SHORTS, SKIN, SHOE)
    out += G(bob, arm(SKIN, True))
    return out


# ---------------------------------------------------------------- room
def room(c, th, R, dark):
    tw = ''
    for i, (x, y, r) in enumerate([(380, 70, 6), (150, 410, 5), (60, 560, 4), (420, 520, 4), (1186, 520, 5)]):
        d = 2.6 + (i % 3) * .7
        cls = c.loop([(0, T(0, 0, 0, .2, opacity=.2)), (d * .5, T(0, 0, 45, 1, opacity=.9), SINE), (d, T(0, 0, 90, .2, opacity=.2))], d)
        tw += at(x, y, G(cls, f'<path d="{spark_d(r)}" fill="{th["twinkle"]}"/>'))
    sway = c.loop([(0, rot(-2.5), SINE), (1.9, rot(2.5), SINE), (3.8, rot(-2.5))], 3.8, origin='1120px 560px')
    leaves = ''.join(f'<ellipse cx="{x}" cy="{y}" rx="{rx}" ry="{ry}" transform="rotate({a} {x} {y})" fill="{R["leaf"] if i % 2 else R["leaf2"]}"/>'
                     for i, (x, y, rx, ry, a) in enumerate([(1094, 516, 13, 34, -32), (1146, 512, 13, 36, 30), (1120, 492, 14, 42, 2),
                                                            (1104, 540, 11, 26, -60), (1138, 540, 11, 26, 58)]))
    glow = c.loop([(0, O(R['glow_op'])), (2.2, O(R['glow_op'] * .78), SINE), (4.4, O(R['glow_op']))], 4.4)
    return (f'<defs><linearGradient id="wall" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{R["wall1"]}"/>'
            f'<stop offset="1" stop-color="{R["wall2"]}"/></linearGradient>'
            f'<linearGradient id="wp" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{th["bg1"]}"/><stop offset="1" stop-color="{th["bg2"]}"/></linearGradient>'
            f'<clipPath id="scr"><rect x="{SX0}" y="{SY0}" width="{SW}" height="{SH}" rx="10"/></clipPath></defs>'
            f'<rect width="{W}" height="{H}" fill="url(#wall)"/>'
            f'<circle cx="120" cy="170" r="250" fill="{th["blob1"]}" opacity=".5"/>'
            f'<ellipse cx="810" cy="250" rx="470" ry="290" fill="{R["tvglow"]}" opacity="{R["tvglow_op"]}"/>' + tw +
            # floor
            f'<rect y="600" width="{W}" height="150" fill="{R["floor"]}"/><rect y="594" width="{W}" height="9" fill="{R["base"]}"/>'
            f'<ellipse cx="250" cy="714" rx="232" ry="30" fill="{R["rug"]}" opacity="{R["rug_op"]}"/>'
            # lamp
            + G(glow, f'<circle cx="52" cy="278" r="96" fill="{R["glow"]}"/>') +
            f'<path d="M52 300V700" stroke="{R["pole"]}" stroke-width="6" stroke-linecap="round"/>'
            f'<ellipse cx="52" cy="704" rx="30" ry="7" fill="{R["pole"]}"/>'
            f'<path d="M22 300L34 250H70L82 300Z" fill="{R["shade"]}"/>'
            # console, laptop, plant
            + rect(596, 516, 452, 74, 14, R['cons_front']) + rect(596, 510, 452, 14, 7, R['cons']) +
            f'<path d="M822 532V578" stroke="{R["cons"]}" stroke-width="3" opacity=".7"/>'
            f'<circle cx="806" cy="554" r="4" fill="{R["knob"]}"/><circle cx="838" cy="554" r="4" fill="{R["knob"]}"/>'
            f'<path d="M624 588L618 612M1020 588L1026 612" stroke="{R["cons_leg"]}" stroke-width="7" stroke-linecap="round"/>'
            + laptop(th, R) +
            rect(1092, 556, 56, 52, 10, R['pot']) + rect(1086, 552, 68, 12, 6, R['pot_rim']) +
            G(sway, leaves))


def laptop(th, R):
    return (rect(663, 458, 78, 52, 6, R['bezel']) + rect(667, 462, 70, 44, 3, 'url(#wp)') +
            rect(674, 468, 46, 26, 3, th['win']) + rect(674, 468, 46, 6, 2, th['winbar']) +
            f'<circle cx="727" cy="498" r="3.2" fill="none" stroke="{CORAL}" stroke-width="1.8"/>'
            + rect(652, 508, 100, 6, 3, R['bezel_hi']) + rect(690, 508, 24, 3, 1.5, R['bezel']))


# ---------------------------------------------------------------- the TV and what it shows
def toolbar_icon(name, x, y, col):
    if name == 'Table':
        return (rect(x - 11, y - 8, 22, 16, 3, 'none', f' stroke="{col}" stroke-width="2"') +
                f'<path d="M{x - 11} {y - 2}H{x + 11}M{x - 3} {y - 8}V{y + 8}" stroke="{col}" stroke-width="2"/>')
    if name == 'Chart':
        return ''.join(rect(x - 10 + i * 7.5, y + 8 - hh, 5, hh, 1.5, col) for i, hh in enumerate((9, 15, 11)))
    if name == 'Text':
        return f'<path d="M{x - 8} {y - 7}H{x + 8}M{x} {y - 7}V{y + 8}" stroke="{col}" stroke-width="2.6" stroke-linecap="round"/>'
    return (f'<circle cx="{x - 3}" cy="{y + 2}" r="6" fill="none" stroke="{col}" stroke-width="2"/>'
            + rect(x, y - 8, 11, 11, 2, 'none', f' stroke="{col}" stroke-width="2"'))


def tile_icon(i, cx, cy, col):
    if i == 0:
        return ''.join(rect(cx - 11 + j * 8, cy + 9 - hh, 6, hh, 1.5, col) for j, hh in enumerate((10, 18, 13)))
    if i == 1:
        return ''.join(rect(cx - 11, cy - 9 + j * 7, ww, 5, 1.5, col) for j, ww in enumerate((14, 22, 10)))
    if i == 2:
        return f'<path d="M{cx - 12} {cy + 7}L{cx - 4} {cy - 1}L{cx + 3} {cy + 3}L{cx + 12} {cy - 8}" fill="none" stroke="{col}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>'
    if i == 3:
        return f'<path d="M{cx - 12} {cy + 9}V{cy + 2}L{cx - 4} {cy - 5}L{cx + 4} {cy}L{cx + 12} {cy - 8}V{cy + 9}Z" fill="{col}"/>'
    if i == 4:
        return (f'<circle cx="{cx}" cy="{cy}" r="10" fill="{col}" opacity=".45"/>'
                f'<path d="M{cx} {cy}V{cy - 10}A10 10 0 0 1 {cx + 9.5} {cy + 3}Z" fill="{col}"/>')
    return ''.join(f'<circle cx="{cx + dx}" cy="{cy + dy}" r="2.6" fill="{col}"/>' for dx, dy in ((-9, 6), (-4, -1), (2, 4), (7, -5), (10, 2)))


def step_label(c, x, y, s, t_in, t_out):
    w = 44 + len(s) * 8.9
    cls = c.anim(pop(c, t_in, t_out, s0=.5), origin=f'{x}px {y + 16}px')
    return G(cls, rect(x, y, w, 32, 16, GLASS, f' stroke="{EDGE}" stroke-opacity=".22" stroke-width="1.3"') +
             f'<circle cx="{x + 17}" cy="{y + 16}" r="7.5" fill="{CORAL}" opacity=".3"/><circle cx="{x + 17}" cy="{y + 16}" r="4.2" fill="{CORAL}"/>' +
             text(x + 30, y + 21.5, s, 16, WHITE, 700))


def capsule(c):
    """Dynamic-Island-style capsule: two caps glide apart, the middle stretches, contents cross-fade."""
    cx, cy, h = CAP
    r = h / 2
    WL, WM, WD = 172, 172, 152
    states = [(tWake, WL), (tWork, WM), (tDone, WD), (tCapMin, h)]
    lf, rf, mf = [(0, T(0, 0))], [(0, T(0, 0))], [(0, T(0, 0, 0, .0001, 1))]
    wprev = h
    for t, w in states:
        d0, d1 = (wprev - h) / 2, (w - h) / 2
        lf += [(t, T(-d0, 0), SPRING), (t + .5, T(-d1, 0))]
        rf += [(t, T(d0, 0), SPRING), (t + .5, T(d1, 0))]
        mf += [(t, T(0, 0, 0, max(wprev - h, .01) / 100, 1), SPRING), (t + .5, T(0, 0, 0, max(w - h, .01) / 100, 1))]
        wprev = w
    lc, rc, mc = c.anim(lf), c.anim(rf), c.anim(mf, origin=f'{cx}px {cy}px')
    def parts(e, fill, op=1):
        a = f' opacity="{op}"' if op != 1 else ''
        return (G(lc, f'<circle cx="{cx}" cy="{cy}" r="{r + e}" fill="{fill}"{a}/>') + G(rc, f'<circle cx="{cx}" cy="{cy}" r="{r + e}" fill="{fill}"{a}/>') +
                G(mc, rect(cx - 50, cy - r - e, 100, h + 2 * e, 0, fill, a)))
    body = parts(1.3, EDGE, .22) + parts(0, GLASS)

    def vis(spans):
        fr = [(0, O(0))]
        for a, b in spans:
            fr += [(a, O(0)), (a + .18, O(1)), (b, O(1)), (b + .1, O(0))]
        return c.anim(fr)
    bars = ''.join(rect(cx - 9.5 + i * 4.2 - 1.2, cy - hh / 2, 2.4, hh, 1.2, WHITE) for i, hh in enumerate((5, 9, 12, 8, 5)))
    m = G(vis([(-1, tWake - .05), (tCapMin + .35, D + 1)]), bars, ' opacity=".5"')
    lx = cx - WL / 2
    lis = G(vis([(tWake + .12, tWork)]),
            f'<circle cx="{lx + 19}" cy="{cy}" r="13" fill="{CORAL}"/>' + mic(lx + 19, cy + 2.5, WHITE, .72) +
            text(lx + 40, cy + 5.5, 'Listening…', 16, WHITE, 600) + eq_bars(c, lx + 136, cy, tWake, tWork - .1, CORAL, n=4, gap=6, hmax=16))
    lx = cx - WM / 2
    spin = c.loop([(0, rot(0)), (.9, rot(360))], .9, origin=f'{lx + 19}px {cy}px')
    wrk = G(vis([(tWork + .12, tDone)]),
            G(spin, f'<circle cx="{lx + 19}" cy="{cy}" r="8" fill="none" stroke="{CORAL}" stroke-width="3.2" stroke-dasharray="34 50" stroke-linecap="round"/>') +
            text(lx + 38, cy + 5.5, 'Making a chart', 16, WHITE, 600))
    lx = cx - WD / 2
    don = G(vis([(tDone + .12, tCapMin)]),
            f'<circle cx="{lx + 19}" cy="{cy}" r="10" fill="#34C759"/>'
            f'<path d="M{lx + 14} {cy}L{lx + 18} {cy + 4}L{lx + 24.5} {cy - 4}" fill="none" stroke="{WHITE}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>' +
            text(lx + 38, cy + 5.5, 'Chart added', 16, WHITE, 600))
    return body + m + lis + wrk + don + burst(c, cx + 70, cy - 22, tWake + .1, 3, 14, 7, (YELLOW, CORAL, BLUSH))


def screen(c, th, R, dark):
    out = [rect(SX0, SY0, SW, SH, 0, 'url(#wp)'),
           f'<circle cx="{SX0 + 60}" cy="{SY0 + 80}" r="150" fill="{th["blob1"]}" opacity=".6"/>'
           f'<circle cx="{SX0 + SW - 40}" cy="{SY0 + SH - 20}" r="170" fill="{th["blob2"]}" opacity=".6"/>']
    # menu bar
    glow = c.anim([(0, O(0)), (tWake, O(0)), (tWake + .15, O(1)), (tCapMin, O(1)), (tCapMin + .3, O(0))])
    out.append(rect(SX0, SY0, SW, 22, 0, th['menubar'], f' opacity="{th["menubar_op"]}"') +
               f'<circle cx="{SX0 + 16}" cy="{SY0 + 11}" r="4.2" fill="none" stroke="{th["menu_text"]}" stroke-width="2"/>' +
               ''.join(text(x, SY0 + 15.5, s, 12, th['menu_text'], 700 if i == 0 else 500)
                       for i, (x, s) in enumerate(zip([SX0 + 30, SX0 + 92, SX0 + 122, SX0 + 152, SX0 + 192], ['Numbers', 'File', 'Edit', 'Insert', 'Table']))) +
               G(glow, f'<circle cx="{SX0 + SW - 76}" cy="{SY0 + 11}" r="9" fill="{CORAL}" opacity=".3"/>') +
               f'<circle cx="{SX0 + SW - 76}" cy="{SY0 + 11}" r="4.6" fill="none" stroke="{CORAL}" stroke-width="2.4"/>' +
               text(SX0 + SW - 12, SY0 + 15.5, 'Thu 9:41', 12, th['menu_text'], 600, 'end'))

    # Numbers-like window
    win = window(th, WX, WY, WW, WH, 'Driftwood Cove', barh=WBAR, r=16)
    press = c.anim([(tClick2, T(0, 0, 0, 1), OUTE), (tClick2 + .07, T(0, 0, 0, .86), SPRING), (tClick2 + .3, T(0, 0, 0, 1))],
                   origin=f'{BTN["Chart"]}px {BTN_Y + 6}px')
    btn_hl = c.anim([(0, O(0)), (tBtn + .45, O(0)), (tBtn + .6, O(1)), (tPopOut, O(1)), (tPopOut + .2, O(0))])
    for name, x in BTN.items():
        ic = toolbar_icon(name, x, BTN_Y, th['sub']) + text(x, BTN_Y + 24, name, 11, th['sub'], 600, 'middle')
        if name == 'Chart':
            ic = G(btn_hl, rect(x - 22, BTN_Y - 15, 44, 46, 9, th['hl'])) + G(press, ic)
        win += ic
    # the table
    tx, ty = TBL_X, TBL_Y
    xs = [tx, tx + COLS[0], tx + COLS[0] + COLS[1], tx + sum(COLS)]
    tw, thh = sum(COLS), ROW * 5
    tbl = (rect(tx, ty, tw, thh, 6, th['win'], f' stroke="{th["winline"]}" stroke-width="1.5"') +
           f'<path d="M{tx + 1} {ty + ROW}V{ty + 6}A5 5 0 0 1 {tx + 6} {ty + 1}H{tx + tw - 6}A5 5 0 0 1 {tx + tw - 1} {ty + 6}V{ty + ROW}Z" fill="{th["field"]}"/>' +
           ''.join(f'<path d="M{tx} {ty + ROW * i}H{tx + tw}" stroke="{th["winline"]}" stroke-width="1.5"/>' for i in range(1, 5)) +
           ''.join(f'<path d="M{x} {ty}V{ty + thh}" stroke="{th["winline"]}" stroke-width="1.5"/>' for x in xs[1:3]) +
           text(xs[0] + 10, ty + 21, 'Month', 13, th['sub'], 700) + text(xs[1] + 10, ty + 21, 'Harbor seals', 13, th['sub'], 700) +
           text(xs[2] + 10, ty + 21, 'Sea lions', 13, th['sub'], 700))
    for i, (m, a, b) in enumerate(DATA):
        y = ty + ROW * (i + 1) + 22
        tbl += text(xs[0] + 10, y, m, 15, th['text'], 700) + text(xs[2] - 12, y, str(a), 15, th['text'], 500, 'end') + text(xs[3] - 12, y, str(b), 15, th['text'], 500, 'end')
    sel = c.anim([(0, T(0, 0, 0, 1.04, opacity=0)), (tClick1 + .03, T(0, 0, 0, 1.04, opacity=0)), (tClick1 + .04, T(0, 0, 0, 1.04, opacity=1), SPRING),
                  (tClick1 + .4, T(0, 0, 0, 1)), (tReset, T(0, 0, 0, 1, opacity=1)), (tReset + .01, T(0, 0, 0, 1, opacity=0))],
                 origin=f'{tx + tw / 2}px {ty + thh / 2}px')
    tbl += G(sel, rect(tx - 4, ty - 4, tw + 8, thh + 8, 9, th['hl'], ' opacity=".35"') +
             rect(tx - 4, ty - 4, tw + 8, thh + 8, 9, 'none', f' stroke="{CORAL}" stroke-width="3"'))
    win += tbl
    # the chart
    cx0, cy0, cw, ch = CHT
    frame = c.anim([(0, T(0, 0, 0, .3, opacity=0)), (tChart, T(0, 0, 0, .3, opacity=0)), (tChart + .01, T(0, 0, 0, .3, opacity=1), SPRING),
                    (tChart + .45, T(0, 0, 0, 1)), (tReset, T(0, 0, 0, 1, opacity=1)), (tReset + .01, T(0, 0, 0, 1, opacity=0))],
                   origin=f'{cx0 + cw / 2}px {cy0 + ch / 2}px')
    chart = (rect(cx0, cy0, cw, ch, 10, th['win'], f' stroke="{th["winline"]}" stroke-width="1.5"') +
             text(cx0 + 14, cy0 + 27, 'Seals by month', 15, th['text'], 700) +
             rect(cx0 + 14, cy0 + 39, 10, 10, 2.5, SEAL_BAR) + text(cx0 + 29, cy0 + 48.5, 'Harbor seals', 12, th['sub'], 600) +
             rect(cx0 + 122, cy0 + 39, 10, 10, 2.5, LION_BAR) + text(cx0 + 137, cy0 + 48.5, 'Sea lions', 12, th['sub'], 600) +
             ''.join(f'<path d="M{cx0 + 14} {fmt(BASE_Y - v * PX_PER)}H{cx0 + cw - 12}" stroke="{th["winline"]}" stroke-width="1.2"/>' for v in (25, 50, 75, 100)) +
             f'<path d="M{cx0 + 14} {BASE_Y}H{cx0 + cw - 12}" stroke="{th["sub"]}" stroke-width="1.5" opacity=".5"/>')
    bars, k = '', 0
    for gx, (m, a, b) in zip(GROUPS, DATA):
        for j, (v, col) in enumerate(((a, SEAL_BAR), (b, LION_BAR))):
            bx = gx - 21.5 if j == 0 else gx + 1.5
            hh = v * PX_PER
            t0 = tBars + k * .12
            fr = [(0, T(0, 0, 0, 1, 0)), (t0, T(0, 0, 0, 1, 0))]
            n = 21
            for i in range(1, n + 1):
                u = i / n
                sy = ease_bar(u)
                sx = min(max(1 - .55 * (sy - 1), .86), 1.2) if sy > .35 else 1.2
                fr.append((t0 + .7 * u, T(0, 0, 0, sx, sy)))
            fr += [(tReset, T(0, 0, 0, 1, 1)), (tReset + .01, T(0, 0, 0, 1, 0))]
            cls = c.anim(fr, origin=f'{fmt(bx + 10)}px {BASE_Y}px')
            bars += G(cls, f'<path d="M{fmt(bx)} {BASE_Y}V{fmt(BASE_Y - hh + 4)}A4 4 0 0 1 {fmt(bx + 4)} {fmt(BASE_Y - hh)}H{fmt(bx + 16)}'
                           f'A4 4 0 0 1 {fmt(bx + 20)} {fmt(BASE_Y - hh + 4)}V{BASE_Y}Z" fill="{col}"/>')
            k += 1
        chart += text(gx, BASE_Y + 18, m, 12, th['sub'], 700, 'middle')
    jx, jy = GROUPS[2] - 11.5, BASE_Y - DATA[2][1] * PX_PER
    peak = c.anim([(0, T(0, 0, 0, 0, opacity=0)), (tPeak, T(0, 0, 0, 0, opacity=0)), (tPeak + .01, T(0, 0, 0, .3, opacity=1), SPRING),
                   (tPeak + .4, T(0, 0, 0, 1)), (tReset, T(0, 0, 0, 1, opacity=1)), (tReset + .01, T(0, 0, 0, 0, opacity=0))],
                  origin=f'{fmt(jx)}px {fmt(jy - 6)}px')
    chart += bars + G(peak, rect(jx - 19, jy - 30, 38, 22, 11, CORAL) + text(jx, jy - 14, '92', 14, WHITE, 800, 'middle') +
                      f'<path d="M{fmt(jx - 5)} {fmt(jy - 9)}L{fmt(jx)} {fmt(jy - 3)}L{fmt(jx + 5)} {fmt(jy - 9)}Z" fill="{CORAL}"/>')
    win += G(frame, chart)
    # the chart picker
    px, py = POPX, POPY
    pw, ph = 3 * TILE[0] + 2 * 6 + 18, 2 * TILE[1] + 6 + 18
    popc = c.anim([(0, T(0, 0, 0, .2, opacity=0)), (tPop, T(0, 0, 0, .2, opacity=0)), (tPop + .01, T(0, 0, 0, .2, opacity=1), SPRING),
                   (tPop + .42, T(0, 0, 0, 1)), (tPopOut, T(0, 0, 0, 1, opacity=1), INE), (tPopOut + .2, T(0, 0, 0, .5, opacity=0))],
                  origin=f'{BTN["Chart"]}px {py}px')
    tile_hl = c.anim([(0, O(0)), (tTile + .3, O(0)), (tTile + .42, O(1))])
    tile_press = c.anim([(tClick3, T(0, 0, 0, 1), OUTE), (tClick3 + .07, T(0, 0, 0, .86), SPRING), (tClick3 + .3, T(0, 0, 0, 1))],
                        origin=f'{px + 9 + TILE[0] / 2}px {py + 9 + TILE[1] / 2}px')
    tiles = ''
    for i in range(6):
        tx_, ty_ = px + 9 + (i % 3) * (TILE[0] + 6), py + 9 + (i // 3) * (TILE[1] + 6)
        t = rect(tx_, ty_, TILE[0], TILE[1], 9, th['field']) + tile_icon(i, tx_ + TILE[0] / 2, ty_ + TILE[1] / 2, SEAL_BAR if i == 0 else th['sub'])
        if i == 0:
            t = G(tile_press, rect(tx_, ty_, TILE[0], TILE[1], 9, th['field']) + G(tile_hl, rect(tx_, ty_, TILE[0], TILE[1], 9, th['hl'])) +
                  tile_icon(i, tx_ + TILE[0] / 2, ty_ + TILE[1] / 2, SEAL_BAR))
        tiles += t
    bx = BTN['Chart']
    win += G(popc, rect(px - 2, py + 8, pw + 4, ph, 14, th['shadow'], f' opacity="{th["shadow_op"] * 1.4}"') +
             f'<path d="M{bx - 9} {py + 1}L{bx} {py - 8}L{bx + 9} {py + 1}Z" fill="{th["win"]}"/>' + rect(px, py, pw, ph, 13, th['win']) + tiles)
    out.append(win)
    out.append(capsule(c))
    return ''.join(out)


def marks(c, th):
    """Ring, ghost cursor, step labels, Hands in the corner. Everything Lookma draws on the TV."""
    out = ''
    cx, cy, _ = CAP
    TBL_CORNER = (TBL_X, TBL_Y)
    BTN_C = (BTN['Chart'], BTN_Y)
    TILE_C = (POPX + 9 + TILE[0] / 2, POPY + 9 + TILE[1] / 2)
    CH_CORNER = (CHT[0], CHT[1])
    AX, AY, S = HANDS
    NOSE = nose_scene(AX, AY, S, -1)

    # ring: out of the capsule, table, Chart, column tile, the new chart, then Hands' nose
    rp = Mover(cx, cy, k=.3, op=0)
    rp.set(tRing0 - .01, op=1)
    rp.move(tRing0, tRing0 + .3, k=1.2, ease=ease_spring)
    rp.move(tTbl, tTbl + .55, x=TBL_CORNER[0], y=TBL_CORNER[1], k=1.25, h=90)
    rp.settle(tTbl + .55, .4, .16)
    rp.move(tBtn, tBtn + .5, x=BTN_C[0], y=BTN_C[1], k=1.5, h=70)
    rp.settle(tBtn + .5, .4, .14)
    rp.move(tTile, tTile + .35, x=TILE_C[0], y=TILE_C[1], k=1.55, h=30)
    rp.settle(tTile + .35, .36, .14)
    rp.move(tChart + .05, tChart + .45, x=CH_CORNER[0], y=CH_CORNER[1], k=1.2, h=40)
    rp.settle(tChart + .45, .36, .14)
    rp.move(tLand - .45, tLand, x=NOSE[0], y=NOSE[1], k=1.0, h=110)
    rp.set(tLand, op=0)
    spin = [(0, rot(0)), (tTbl, rot(0), OUTE), (tTbl + .55, rot(360)), (tBtn, rot(360), INOUT), (tBtn + .5, rot(720)),
            (tTile, rot(720), INOUT), (tTile + .35, rot(900)), (tChart + .05, rot(900), INOUT), (tChart + .45, rot(1080)),
            (tLand - .45, rot(1080), OUTE), (tLand, rot(1440)), (tLand + .05, rot(0))]
    ring = ring_el(c, rp, 11.2, 5.9, spin)
    trail = ''
    for i, u in enumerate([.25, .5, .75]):
        tt = tLand - .45 + .45 * u
        x, y = rp.pos(tt)
        trail += sparkle(c, x + (6 if i % 2 else -6), y + 8, tt, 8 if i % 2 else 10, YELLOW if i % 2 == 0 else BLUSH)

    # ghost cursor trails the ring by a beat
    cp = Mover(cx + 26, cy - 14, k=.85, op=0)
    cp.move(tRing0 + .2, tRing0 + .4, op=1)
    cp.move(tTbl + .08, tTbl + .62, x=TBL_CORNER[0] + 7, y=TBL_CORNER[1] + 9, ease=ease_spring)
    cp.move(tBtn + .06, tBtn + .56, x=BTN_C[0] + 6, y=BTN_C[1] + 8, ease=ease_spring)
    cp.move(tTile + .05, tTile + .42, x=TILE_C[0] + 6, y=TILE_C[1] + 8, ease=ease_spring)
    cp.move(tChart + .1, tChart + .5, x=CH_CORNER[0] + 10, y=CH_CORNER[1] + 12, ease=ease_spring)
    cp.move(tChart + .9, tChart + 1.2, op=0)
    clicks = [tClick1, tClick2, tClick3]
    cursor = cursor_el(c, cp, clicks)
    ripples = ''
    for tc, (x, y) in zip(clicks, [TBL_CORNER, BTN_C, TILE_C]):
        cls = c.anim([(0, T(0, 0, 0, .2, opacity=0)), (tc, T(0, 0, 0, .2, opacity=0)), (tc + .01, T(0, 0, 0, .3, opacity=.85), OUTE),
                      (tc + .45, T(0, 0, 0, 1.5, opacity=0))])
        ripples += at(x + 2, y + 2, G(cls, f'<circle r="18" fill="none" stroke="{CORAL}" stroke-width="3"/>'))

    labels = (step_label(c, TBL_X + 22, TBL_Y - 38, 'Select table', tTbl + .55, tBtn - .1) +
              step_label(c, POPX + 18, POPY + 2 * TILE[1] + 34, 'Insert chart', tBtn + .5, tChart))

    # Hands: pops up in the corner, catches the ring, claps, waves, sinks
    hp = Mover(AX, HANDS_HIDDEN, k=S, ox=256, oy=488)
    hp.hold(tHands)
    hp.move(tHands, tHands + .5, y=AY, ease=ease_spring)
    hp.move(tLand, tLand + .12, y=AY - 10, ease=ease_out)
    hp.move(tLand + .12, tLand + .26, y=AY, ease=ease_in)
    hp.hold(tSink)
    hp.move(tSink, tSink + .14, y=AY - 12, ease=ease_out)
    hp.move(tSink + .14, tSink + .5, y=HANDS_HIDDEN, ease=ease_in)
    k = std_hands_joints(c, D, [10.2, 12.9, 14.6, 15.2], happy=[(tLand + .02, tClap + .9), (tWave, tWave + .7)])
    k['pos'] = c.anim(hp.frames())
    k['flip'] = c.anim([(0, {'transform': 'scale(-1,1)'})])
    k['sq'] = c.anim([(0, T(0, 0, 0, 1, 1)), (tHands, T(0, 0, 0, .86, 1.16), OUTE), (tHands + .3, T(0, 0, 0, 1.08, .93), SINE),
                      (tHands + .5, T(0, 0, 0, 1, 1)), (tLand + .24, T(0, 0, 0, 1, 1)), (tLand + .27, T(0, 0, 0, 1.12, .88), OUTE),
                      (tLand + .45, T(0, 0, 0, 1, 1)), (tSink + .1, T(0, 0, 0, 1.1, .9)), (tSink + .2, T(0, 0, 0, .9, 1.12)), (tSink + .5, T(0, 0, 0, 1, 1))])
    k['head'] = c.anim([(0, rot(0)), (tLand, rot(0), SPRING), (tLand + .15, rot(-10)), (tLand + .5, rot(0)),
                        (tPeak, rot(0), SINE), (tPeak + .2, rot(8), SINE), (tPeak + .45, rot(0))])
    k['nose'] = c.anim([(0, T(0, 0, 0, opacity=0)), (tLand - .01, T(0, 0, 0, opacity=0)), (tLand, T(0, -24, -16, opacity=1), SPRING),
                        (tLand + .32, T(0, 0, 0)), (tWave, T(0, 0, 0), SINE), (tWave + .2, T(0, -10, 8), SINE), (tWave + .45, T(0, 0, 0)),
                        (tSink + .5, T(0, 0, 0, opacity=1)), (tSink + .51, T(0, 0, 0, opacity=0))])
    fl, fr = [(0, rot(0))], [(0, rot(0))]
    for i in range(3):
        t0 = tClap + i * .18
        fl += [(t0, rot(38), SINE), (t0 + .09, rot(92), SINE)]
        fr += [(t0, rot(-38), SINE), (t0 + .09, rot(-92), SINE)]
    fl += [(tClap + .6, rot(0))]
    fr += [(tClap + .6, rot(0))]
    for i, a in enumerate([-30, 10, -30, 8, -24]):
        fr.append((tWave + i * .13, rot(a), SINE))
    fr.append((tWave + 5 * .13, rot(0)))
    k['fl'], k['fr'] = c.anim(fl), c.anim(fr)
    seal = hands_svg(k)
    clap_pt = (AX, AY - (488 - 250) * S)
    fx = ''
    for i in range(3):
        fx += sparkle(c, clap_pt[0] + (-22 if i % 2 else 18), clap_pt[1] - 26 - i * 5, tClap + .1 + i * .18, 8 + (i % 2) * 3,
                      YELLOW if i % 2 == 0 else CORAL)
    fx += heart(c, AX - 46, AY - 140, tClap + .3, 10, CORAL, -12, 60) + heart(c, AX - 20, AY - 150, tClap + .5, 7, DEEP, 8, 50)
    fx += burst(c, GROUPS[2] - 11.5, BASE_Y - DATA[2][1] * PX_PER - 40, tPeak + .05, 4, 26, 8)
    return seal + fx + trail + ring + labels + cursor + ripples


def wipe(c, th):
    """A soft sweep across the screen; the chart resets while it covers everything."""
    pw = 1120
    cls = c.anim([(0, T(0, 0)), (tWipe, T(0, 0), INOUT), (tWipe + WIPE, T(pw + SW + 20, 0))])
    x0 = SX0 - pw - 10
    return G(cls, rect(x0, SY0 - 220, pw, SH + 440, 220, th['disc']) +
             f'<circle cx="{x0 + pw / 2}" cy="{SY0 + SH / 2}" r="46" fill="none" stroke="{CORAL}" stroke-width="20"/>'
             f'<circle cx="{x0 + pw / 2 - 30}" cy="{SY0 + SH / 2 - 30}" r="6" fill="{WHITE}" opacity=".9"/>')


def tv(c, th, R, dark):
    x, y, w, h = TV
    return (rect(x + 4, y + 14, w - 8, h, 26, th['shadow'], f' opacity="{th["shadow_op"] * 1.2}"') +
            rect(x, y, w, h, 22, R['bezel']) + rect(x + 3, y + 3, w - 6, h - 6, 20, 'none', f' stroke="{R["bezel_hi"]}" stroke-width="1.5" opacity=".7"') +
            f'<g clip-path="url(#scr)">' + screen(c, th, R, dark) + marks(c, th) + wipe(c, th) + '</g>' +
            f'<circle cx="{x + w / 2}" cy="{y + h - 6}" r="2" fill="{R["bezel_hi"]}"/>')


# ---------------------------------------------------------------- bubbles and the distance beat
def rider_bubble(c, th):
    bx, by, bw, bh = 28, 146, 418, 108
    tip = (272, 300)
    cls = c.anim(pop(c, tSay, tBubOut, s0=.5), origin=f'{tip[0]}px {tip[1]}px')
    l1x, l2x = bx + 92, bx + 92
    cv1 = c.anim([(0, {'transform': 'scale(1,1)'}), (tSay + .15, {'transform': 'scale(1,1)'}, 'steps(11,end)'), (tWake - .05, {'transform': 'scale(0,1)'})],
                 origin=f'{l1x + 156}px 0px')
    cv2 = c.anim([(0, {'transform': 'scale(1,1)'}), (tWake + .15, {'transform': 'scale(1,1)'}, 'steps(27,end)'), (tWake + 1.4, {'transform': 'scale(0,1)'})],
                 origin=f'{l2x + 316}px 0px')
    return G(cls, f'<path d="{bubble_d(bx, by, bw, bh, 28, 262, tip[0], tip[1])}" fill="{th["ububble"]}"/>' +
             rect(bx + 22, by + 30, 48, 48, 24, th['hl']) + mic(bx + 46, by + 56, CORAL, 1.1) +
             f'<text x="{l1x}" y="{by + 46}" font-size="27" font-weight="700" fill="{th["utext"]}">Hey <tspan fill="{th["tagline"]}">Lookma</tspan>,</text>' +
             text(l2x, by + 84, 'visualize this data for me.', 24, th['utext'], 500) +
             G(cv1, rect(l1x - 3, by + 18, 160, 36, 0, th['ububble'])) + G(cv2, rect(l2x - 3, by + 60, 320, 34, 0, th['ububble'])) +
             eq_bars(c, bx + bw - 56, by + 36, tSay + .15, tWake + 1.4, CORAL))


def reply_bubble(c):
    bx, by, bw, bh = 116, 150, 330, 54
    tip = (478, 236)
    cls = c.anim(pop(c, tReply, tReplyOut, s0=.4), origin=f'{tip[0]}px {tip[1]}px')
    return G(cls, f'<path d="{bubble_d(bx, by, bw, bh, bh / 2, bx + bw - 40, tip[0], tip[1])}" fill="{CORAL}"/>' +
             text(bx + bw / 2, by + 35, 'Done — seals peak in July.', 21, WHITE, 700, 'middle'))


def distance(c, th, R):
    a, b = (432, 704), (618, 618)
    n = 15
    out = ''
    for i in range(n + 1):
        u = i / n
        x, y = a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u
        t0 = tDist + i * .035
        end = i in (0, n)
        cls = c.anim([(0, T(0, 0, 0, 0)), (t0, T(0, 0, 0, 0), SPRING), (t0 + .3, T(0, 0, 0, 1)), (tDistOut + i * .01, T(0, 0, 0, 1), INE),
                      (tDistOut + i * .01 + .2, T(0, 0, 0, 0))])
        out += at(x, y, G(cls, f'<circle r="{6 if end else 3.4}" fill="{CORAL if end else R["dots"]}"/>'))
    mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
    pill = c.anim(pop(c, tDist + .65, tDistOut, s0=.3), origin=f'{mx}px {my}px')
    out += G(pill, rect(mx - 34, my - 19, 68, 38, 19, th['shadow'], f' opacity="{th["shadow_op"]}" transform="translate(0 4)"') +
             rect(mx - 34, my - 19, 68, 38, 19, R['pill']) + text(mx, my + 8, '3 m', 22, R['pill_text'], 800, 'middle'))
    cap = c.anim(pop(c, tDist + .95, tDistOut, s0=.6), origin='690px 700px')
    out += G(cap, text(560, 708, 'Look ma, no hands.', 30, th['tagline'], 800, extra=' letter-spacing="-.8"'))
    out += sparkle(c, mx + 44, my - 22, tDist + .8, 9, YELLOW) + sparkle(c, 868, 680, tDist + 1.2, 10, YELLOW) + sparkle(c, 548, 682, tDist + 1.3, 7, CORAL)
    return out


def build_bike(th, dark):
    c = Clock(D, 'k')
    R = ROOM[dark]
    body = [room(c, th, R, dark), tv(c, th, R, dark), distance(c, th, R),
            at(*BIKE_AT, rider(c, th, R)),
            sparkle(c, BIKE_AT[0] + 104, BIKE_AT[1] - 300, tThumb + .35, 11, YELLOW) +
            sparkle(c, BIKE_AT[0] + 66, BIKE_AT[1] - 288, tThumb + .5, 8, CORAL),
            rider_bubble(c, th), reply_bubble(c)]
    style = (f'text{{font-family:{FONT}}}'
             f'@media (prefers-reduced-motion:reduce){{*{{animation-delay:-{fmt(FREEZE)}s!important;animation-play-state:paused!important}}}}\n'
             + '\n'.join(c.css))
    return svg_doc(W, H, 'Lookma: from a bike across the room, you ask for a chart and your Mac makes it. You never touch it.',
                   style, ''.join(body))


def main():
    for dark, th, suffix in ((False, LIGHT, ''), (True, DARK, '-dark')):
        with open(os.path.join(OUT, f'bike{suffix}.svg'), 'w') as f:
            f.write(build_bike(th, dark))


if __name__ == '__main__':
    main()

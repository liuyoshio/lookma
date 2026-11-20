#!/usr/bin/env python3
"""Lookma launch animations: self-contained animated SVGs (CSS keyframes, no JS).

    python3 brand/src/anim/animgen.py      # writes brand/demo*.svg and brand/feature-*.svg

Every file runs on one master clock. Times are authored in seconds and turned into
keyframe percentages, so a beat is retimed by editing one number. Motion that needs a
path (arcs, hops, springs) is baked into dense linear keyframes by `Mover`.
"""
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.dirname(os.path.dirname(HERE))  # brand/

CORAL, DEEP, BLUSH, INK, WHITE = '#FF805C', '#E9603A', '#FFC6B2', '#1B1B1F', '#FFFFFF'
YELLOW = '#FFD966'
FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI','Helvetica Neue',Arial,sans-serif"

SPRING = 'cubic-bezier(.34,1.56,.64,1)'
BOING = 'cubic-bezier(.28,2.1,.6,1)'
OUTE = 'cubic-bezier(.22,1,.36,1)'
INE = 'cubic-bezier(.55,0,1,.45)'
INOUT = 'cubic-bezier(.65,0,.35,1)'
SINE = 'cubic-bezier(.37,0,.63,1)'

LIGHT = dict(
    bg1='#FFE8DC', bg2='#E9E4FB', blob1='#FFD2C0', blob2='#D3E4FF', blob3='#FFF0BD',
    menubar='#FFFFFF', menubar_op=.6, menu_text='#5E5752',
    dock='#FFFFFF', dock_op=.55, dock_line='#FFFFFF',
    win='#FFFFFF', winbar='#F7F2EE', winline='#EEE6E0', text=INK, sub='#8C847E',
    shadow='#A8705A', shadow_op=.15, field='#F3EEEA', hl='#FFE7DD',
    land='#F6F1E6', park='#CDEBC4', water='#BEE0F6', road='#FFFFFF', bldg='#E9C9B3',
    ububble='#FFFFFF', utext=INK, notesbar='#FFF2C4',
    title_bg='#F7F2EC', disc='#FBE3D9', word=INK, tagline=DEEP, tagsub='#6E6762',
    key='#FFFFFF', key_side='#E2D6CD', key_text=INK, dim='#3A2A24', dim_op=.16,
    twinkle='#FFFFFF',
)
DARK = dict(
    bg1='#2C2541', bg2='#16151D', blob1='#47293F', blob2='#22345A', blob3='#3B3322',
    menubar='#121218', menubar_op=.55, menu_text='#B8B2BC',
    dock='#3A3846', dock_op=.62, dock_line='#5C5868',
    win='#2A2930', winbar='#34323C', winline='#403E48', text='#F2EEEA', sub='#9E98A4',
    shadow='#000000', shadow_op=.32, field='#383640', hl='#4A3530',
    land='#30333F', park='#2E4A3B', water='#24405C', road='#454B5D', bldg='#7A5F52',
    ububble='#383641', utext='#F2EEEA', notesbar='#4B4330',
    title_bg='#232327', disc='#3B2C2A', word='#F2EEEA', tagline=CORAL, tagsub='#A6A0AB',
    key='#3A3946', key_side='#1E1D25', key_text='#F2EEEA', dim='#000000', dim_op=.3,
    twinkle='#FFE2D6',
)


# ---------------------------------------------------------------- small helpers
def fmt(v, nd=2):
    s = f'{v:.{nd}f}'.rstrip('0').rstrip('.')
    return '0' if s in ('-0', '') else s


def esc(s):
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def tf(x=0, y=0, r=0, sx=1, sy=None):
    sy = sx if sy is None else sy
    return f'translate({fmt(x)}px,{fmt(y)}px) rotate({fmt(r)}deg) scale({fmt(sx, 3)},{fmt(sy, 3)})'


def T(x=0, y=0, r=0, sx=1, sy=None, **more):
    d = {'transform': tf(x, y, r, sx, sy)}
    d.update({k.replace('_', '-'): (fmt(v, 3) if isinstance(v, (int, float)) else v) for k, v in more.items()})
    return d


def O(v):
    return {'opacity': fmt(v, 3)}


def G(cls, inner, attrs=''):
    c = f' class="{cls}"' if cls else ''
    return f'<g{c}{attrs}>{inner}</g>'


def at(x, y, inner, extra=''):
    return f'<g transform="translate({fmt(x)} {fmt(y)}){extra}">{inner}</g>'


def rect(x, y, w, h, r, fill, extra=''):
    return f'<rect x="{fmt(x)}" y="{fmt(y)}" width="{fmt(w)}" height="{fmt(h)}" rx="{fmt(r)}" fill="{fill}"{extra}/>'


def text(x, y, s, size, fill, weight=500, anchor='start', extra=''):
    a = '' if anchor == 'start' else f' text-anchor="{anchor}"'
    return f'<text x="{fmt(x)}" y="{fmt(y)}" font-size="{size}" font-weight="{weight}" fill="{fill}"{a}{extra}>{esc(s)}</text>'


def spark_d(r):
    q = r * .2
    return (f'M0 {fmt(-r)}Q{fmt(q)} {fmt(-q)} {fmt(r)} 0Q{fmt(q)} {fmt(q)} 0 {fmt(r)}'
            f'Q{fmt(-q)} {fmt(q)} {fmt(-r)} 0Q{fmt(-q)} {fmt(-q)} 0 {fmt(-r)}Z')


def bubble_d(x, y, w, h, r, tx, tipx, tipy):
    """Rounded speech bubble; the tail leaves the bottom edge at tx and ends at (tipx, tipy)."""
    b = y + h
    return (f'M{fmt(x + r)} {fmt(y)}H{fmt(x + w - r)}A{r} {r} 0 0 1 {fmt(x + w)} {fmt(y + r)}V{fmt(b - r)}'
            f'A{r} {r} 0 0 1 {fmt(x + w - r)} {fmt(b)}H{fmt(tx + 13)}Q{fmt(tx + 5)} {fmt(b + 3)} {fmt(tipx)} {fmt(tipy)}'
            f'Q{fmt(tx - 3)} {fmt(b + 5)} {fmt(tx - 13)} {fmt(b)}H{fmt(x + r)}A{r} {r} 0 0 1 {fmt(x)} {fmt(b - r)}'
            f'V{fmt(y + r)}A{r} {r} 0 0 1 {fmt(x + r)} {fmt(y)}Z')


def ease_io(u):
    return 4 * u ** 3 if u < .5 else 1 - (-2 * u + 2) ** 3 / 2


def ease_out(u):
    return 1 - (1 - u) ** 3


def ease_in(u):
    return u ** 3


def ease_spring(u):
    return 1.0 if u >= 1 else 1 - math.exp(-6.2 * u) * math.cos(2 * math.pi * 1.05 * u)


# ---------------------------------------------------------------- clock
class Clock:
    """Collects @keyframes. Frames are (t_seconds, {prop: value}, easing_from_here)."""

    def __init__(self, dur, ns):
        self.dur, self.ns, self.css, self.n = dur, ns, [], 0

    def anim(self, frames, origin=None, box=None, dur=None):
        dur = dur or self.dur
        self.n += 1
        name = f'{self.ns}{self.n}'
        norm = [(f[0], f[1], f[2] if len(f) > 2 else None) for f in frames]
        first = {}
        for _, p, _ in norm:
            for k, v in p.items():
                first.setdefault(k, v)
        out, cur = [], dict(first)
        for t, p, e in norm:
            cur = {**cur, **p}
            t = min(max(t, 0), dur)
            if out and abs(out[-1][0] - t) < 1e-6:
                out[-1] = (t, dict(cur), e)
            else:
                out.append((t, dict(cur), e))
        if out[0][0] > 0:
            out.insert(0, (0, out[0][1], None))
        if out[-1][0] < dur:
            out.append((dur, out[-1][1], None))
        blocks = []
        for t, p, e in out:
            decl = ';'.join(f'{k}:{v}' for k, v in p.items())
            if e:
                decl += f';animation-timing-function:{e}'
            blocks.append(f'{fmt(t / dur * 100, 3)}%{{{decl}}}')
        self.css.append(f'@keyframes {name}{{{"".join(blocks)}}}')
        rule = f'.{name}{{animation:{name} {fmt(dur, 3)}s linear infinite both'
        if origin:
            rule += f';transform-origin:{origin}'
        if box:
            rule += f';transform-box:{box}'
        self.css.append(rule + '}')
        return name

    def loop(self, frames, dur, origin=None, box=None):
        """A short independent loop (idle bob, wag, twinkle). Frames in seconds within dur."""
        return self.anim(frames, origin, box, dur=dur)


class Mover:
    """Baked 2D motion for translate(x,y) scale(k) + opacity, anchored at (ox, oy) of the art."""

    def __init__(self, x, y, k=1.0, op=1.0, ox=0.0, oy=0.0, fps=30):
        self.x, self.y, self.k, self.op, self.ox, self.oy, self.fps = x, y, k, op, ox, oy, fps
        self.s = [(0.0, x, y, k, op)]

    def _push(self, t):
        self.s.append((t, self.x, self.y, self.k, self.op))

    def hold(self, t):
        self._push(t)
        return self

    def set(self, t, **kw):
        self._push(t)
        for a, v in kw.items():
            setattr(self, a, v)
        self._push(t + .01)
        return self

    def move(self, t0, t1, x=None, y=None, k=None, op=None, h=0.0, ease=ease_io):
        x0, y0, k0, op0 = self.x, self.y, self.k, self.op
        x1 = x0 if x is None else x
        y1 = y0 if y is None else y
        k1 = k0 if k is None else k
        op1 = op0 if op is None else op
        self._push(t0)
        n = max(3, round((t1 - t0) * self.fps))
        for i in range(1, n + 1):
            u = i / n
            e = ease(u)
            ea = min(max(e, 0), 1)
            self.x = x0 + (x1 - x0) * e
            self.y = y0 + (y1 - y0) * e - h * 4 * ea * (1 - ea)
            self.k = k0 + (k1 - k0) * e
            self.op = op0 + (op1 - op0) * min(1, u * 2.5)
            self._push(t0 + (t1 - t0) * u)
        self.x, self.y, self.k, self.op = x1, y1, k1, op1
        self._push(t1)
        return self

    def settle(self, t0, dur=.42, amp=.14):
        k1 = self.k
        n = max(4, round(dur * self.fps))
        for i in range(1, n + 1):
            u = i / n
            self.k = k1 * (1 + amp * math.exp(-4.5 * u) * math.sin(2 * math.pi * 1.6 * u))
            self._push(t0 + dur * u)
        self.k = k1
        self._push(t0 + dur)
        return self

    def pos(self, t):
        prev = self.s[0]
        for s in self.s:
            if s[0] >= t:
                if s[0] == prev[0]:
                    return s[1], s[2]
                u = (t - prev[0]) / (s[0] - prev[0])
                return prev[1] + (s[1] - prev[1]) * u, prev[2] + (s[2] - prev[2]) * u
            prev = s
        return prev[1], prev[2]

    def frames(self, extra=None):
        out = []
        for t, x, y, k, op in self.s:
            d = {'transform': f'translate({fmt(x - self.ox * k)}px,{fmt(y - self.oy * k)}px) scale({fmt(k, 4)})',
                 'opacity': fmt(op, 3)}
            out.append((t, d))
        return out

    def extra_frames(self, fn):
        return [(t, fn(k, op)) for t, x, y, k, op in self.s]


def sparkle(c, x, y, t, r=10, color=YELLOW, dur=.6, rot=0):
    cls = c.anim([(t, T(0, 0, rot, 0)), (t + .01, T(0, 0, rot, .2), OUTE), (t + dur * .4, T(0, 0, rot + 45, 1.15), INE),
                  (t + dur, T(0, 0, rot + 90, 0))])
    return at(x, y, G(cls, f'<path d="{spark_d(r)}" fill="{color}"/>'))


def heart(c, x, y, t, r=11, color=CORAL, dx=0.0, rise=80):
    q = r
    d = (f'M0 {fmt(q * .95)}C{fmt(-q * 1.7)} {fmt(-q * .15)} {fmt(-q * .75)} {fmt(-q * 1.45)} 0 {fmt(-q * .45)}'
         f'C{fmt(q * .75)} {fmt(-q * 1.45)} {fmt(q * 1.7)} {fmt(-q * .15)} 0 {fmt(q * .95)}Z')
    cls = c.anim([(t, T(0, 0, 0, 0, opacity=1)), (t + .01, T(0, 0, -10, .3, opacity=1), SPRING), (t + .3, T(dx * .3, -rise * .3, 6, 1)),
                  (t + .7, T(dx * .7, -rise * .75, -6, .95, opacity=1)), (t + 1.0, T(dx, -rise, 0, .8, opacity=0))])
    return at(x, y, G(cls, f'<path d="{d}" fill="{color}"/>'))


def burst(c, x, y, t, n=4, rad=34, r=9, colors=(YELLOW, CORAL, BLUSH, WHITE), rot0=20):
    out = ''
    for i in range(n):
        a = math.radians(rot0 + i * 360 / n)
        out += sparkle(c, x + math.cos(a) * rad, y + math.sin(a) * rad, t + i * .05, r * (1 if i % 2 == 0 else .7),
                       colors[i % len(colors)])
    return out


def pop(c, t_in, t_out=None, s0=.3, dur_in=.38, dur_out=.22, extra_in=None):
    """Spring pop-in (and optional shrink-out) on scale + opacity."""
    fr = [(t_in, T(0, 0, 0, s0, opacity=0)), (t_in + .01, T(0, 0, 0, s0, opacity=1), SPRING),
          (t_in + dur_in, T(0, 0, 0, 1, opacity=1))]
    if t_out is not None:
        fr += [(t_out, T(0, 0, 0, 1, opacity=1), INE), (t_out + dur_out, T(0, 0, 0, .6, opacity=0))]
    return fr


# ---------------------------------------------------------------- Hands
TAIL_D = 'M0 -14C21 -22 48 -21 60 -3C61 10 42 19 24 17C12 16 0 14 0 14Z'
BODY_D = ('M143.9 318.8L230.4 169.8A84 84 0 0 1 288.5 129.3L326.4 122.6A38 38 0 0 1 368.7 147L381.9 183.2'
          'A84 84 0 0 1 384.9 230.9L346.2 398.7A110 110 0 1 1 143.9 318.8Z')
FLIPPER_D = 'M0 -16C30 -27 74 -35 99 -16C114 -4 107 17 85 24C61 31 27 23 0 16A16 16 0 0 1 0 -16Z'


def hands_svg(k, extra_head='', nose_extra='', above=''):
    """Hands in its 512 art space, rigged. k maps joint -> animation class (missing = static)."""
    def j(name, inner, origin=None):
        cls = k.get(name)
        st = f' style="transform-origin:{origin}"' if origin else ''
        return f'<g class="{cls}"{st}>{inner}</g>' if cls else inner

    tail = (f'<path d="{TAIL_D}" fill="{DEEP}" transform="translate(-28 -2) rotate(160)"/>'
            f'<path d="{TAIL_D}" fill="{DEEP}" transform="translate(28 2) rotate(22)"/>')
    eye = lambda x, hx: (f'<circle cx="{x}" cy="-17" r="11.5" fill="{INK}"/>'
                         f'<circle cx="{hx}" cy="-21" r="3.8" fill="{WHITE}"/>')
    eyes = (j('eyeperk', j('blink', eye(-40, -36.5), '-40px -17px'), '-40px -17px') +
            j('eyeperk', j('blink', eye(40, 43.5), '40px -17px'), '40px -17px'))
    happy = (f'<g fill="none" stroke="{INK}" stroke-width="7" stroke-linecap="round">'
             f'<path d="M-52 -12Q-40 -31 -28 -12"/><path d="M28 -12Q40 -31 52 -12"/></g>'
             f'<ellipse cx="-50" cy="8" rx="13" ry="7.5" fill="#FF6F5A" opacity=".45"/>'
             f'<ellipse cx="50" cy="8" rx="13" ry="7.5" fill="#FF6F5A" opacity=".45"/>')
    head = (f'<circle cx="-14" cy="-55" r="17" fill="{BLUSH}"/><circle cx="14" cy="-55" r="17" fill="{BLUSH}"/>'
            f'<g fill="none" stroke="{INK}" stroke-linecap="round">'
            f'<path d="M-31 -61L-49 -67M-31 -51L-50 -49M31 -61L49 -67M31 -51L50 -49" stroke-width="3.2"/>'
            f'<path d="M-19 -47Q-9.5 -37 0 -46Q9.5 -37 19 -47" stroke-width="3.4"/></g>'
            f'<ellipse cx="0" cy="-69" rx="10.5" ry="7.5" fill="{INK}"/>'
            + j('eyes_on', eyes) + (G(k['happy'], happy, ' opacity="0"') if 'happy' in k else '') + extra_head)
    ring = f'<circle cx="0" cy="-49.4" r="40" fill="none" stroke="{CORAL}" stroke-width="21"/>'
    body = (at(241, 466, j('tail', tail)) +
            f'<path d="{BODY_D}" fill="{CORAL}"/>'
            f'<ellipse cx="253" cy="392" rx="64" ry="78" transform="rotate(18 253 392)" fill="{BLUSH}"/>' +
            at(177, 328, j('fl', f'<path d="{FLIPPER_D}" fill="{DEEP}" transform="rotate(-146)"/>')) +
            at(337, 312, j('fr', f'<path d="{FLIPPER_D}" fill="{DEEP}" transform="rotate(-32)"/>')) +
            f'<g transform="translate(303 212) rotate(30)">{j("head", head, "0px 30px")}</g>' +
            at(352, 114, j('nose', ring) + nose_extra) + above)
    inner = j('bob', body, '256px 488px')
    inner = j('sq', inner, '256px 488px')
    inner = j('flip', inner, '256px 0px')
    return j('pos', inner)


def blink_frames(times):
    fr = [(0, {'transform': 'scale(1,1)'})]
    for tb in times:
        fr += [(tb, {'transform': 'scale(1,1)'}), (tb + .06, {'transform': 'scale(1.06,.1)'}),
               (tb + .15, {'transform': 'scale(1,1)'})]
    return fr


def window_frames(t_open, t_close=None, close_dur=.35, s0=.06, fade_to=None):
    fr = [(t_open, T(0, 0, 0, s0, opacity=0)), (t_open + .01, T(0, 0, 0, s0, opacity=1), SPRING),
          (t_open + .5, T(0, 0, 0, 1, opacity=1))]
    if t_close is not None:
        fr += [(t_close, T(0, 0, 0, 1, opacity=1), INE), (t_close + close_dur, T(0, 0, 0, .94, opacity=0))]
    return fr


def window(th, x, y, w, h, title, bar=None, barh=46, r=20):
    bar = bar or th['winbar']
    tl = ''.join(f'<circle cx="{fmt(x + 24 + i * 22)}" cy="{fmt(y + barh / 2)}" r="6.5" fill="{col}"/>'
                 for i, col in enumerate(('#FF8B80', '#FFCB57', '#6CCF8A')))
    return (rect(x - 2, y + 10, w + 4, h, r + 2, th['shadow'], f' opacity="{th["shadow_op"]}"') +
            rect(x, y, w, h, r, th['win']) +
            f'<path d="M{x} {y + barh}V{y + r}A{r} {r} 0 0 1 {x + r} {y}H{x + w - r}A{r} {r} 0 0 1 {x + w} {y + r}V{y + barh}Z" fill="{bar}"/>'
            f'<path d="M{x} {y + barh}H{x + w}" stroke="{th["winline"]}" stroke-width="1.5"/>' + tl +
            text(x + w / 2, y + barh / 2 + 6, title, 16, th['sub'], 700, 'middle'))


def mic(x, y, color, s=1.0):
    return at(x, y, f'<g transform="scale({s})"><rect x="-5.5" y="-12" width="11" height="17" rx="5.5" fill="{color}"/>'
                    f'<path d="M-9 0A9 9 0 0 0 9 0M0 9V13M-5 13H5" fill="none" stroke="{color}" stroke-width="2.6" stroke-linecap="round"/></g>')


def eq_bars(c, x, y, t0, t1, color, n=4, gap=7, hmax=18):
    """Little voice-level bars that dance while someone is talking."""
    out = ''
    for i in range(n):
        fr = [(0, {'transform': 'scale(1,.25)'}), (t0, {'transform': 'scale(1,.25)'})]
        t, j = t0, 0
        while t < t1:
            t += .11
            v = .3 + .7 * abs(math.sin(i * 1.7 + j * 2.3))
            fr.append((t, {'transform': f'scale(1,{fmt(v, 2)})'}))
            j += 1
        fr.append((t1 + .12, {'transform': 'scale(1,.25)'}))
        cls = c.anim(fr, origin=f'{fmt(x + i * gap)}px {fmt(y)}px')
        out += G(cls, rect(x + i * gap - 2, y - hmax / 2, 4, hmax, 2, color), '')
    return out


def keycap(th, cx, cy, label, sub_label, cls_pop, cls_press, size=86):
    h = size / 2
    top = (rect(cx - h, cy - h, size, size - 4, 18, th['key'], f' stroke="{th["key_side"]}" stroke-width="2"') +
           text(cx, cy + (8 if not sub_label else 4), label, 38 if not sub_label else 34, th['key_text'], 600, 'middle'))
    if sub_label:
        top += text(cx, cy + 28, sub_label, 12, th['sub'], 600, 'middle')
    return G(cls_pop, rect(cx - h, cy - h + 8, size, size - 4, 18, th['key_side']) + G(cls_press, top))


def stamp_svg():
    """Coral wax seal with a tiny Hands face and an APPROVED ribbon. Centered on 0,0."""
    pts = []
    for i in range(72):
        a = i / 72 * 2 * math.pi
        rr_ = 68 + 3.2 * math.sin(a * 9) + 1.6 * math.sin(a * 5 + 1)
        pts.append(f'{fmt(math.cos(a) * rr_)} {fmt(math.sin(a) * rr_)}')
    wax = f'<path d="M{"L".join(pts)}Z" fill="{DEEP}"/>'
    drip = f'<path d="M38 52Q46 70 40 80Q33 88 28 79Q25 70 30 56Z" fill="{DEEP}"/>'
    face = (f'<circle cx="-9" cy="-10" r="10.5" fill="{BLUSH}"/><circle cx="9" cy="-10" r="10.5" fill="{BLUSH}"/>'
            f'<ellipse cx="0" cy="-19" rx="6.8" ry="4.8" fill="{INK}"/>'
            f'<circle cx="-24" cy="-26" r="6" fill="{INK}"/><circle cx="24" cy="-26" r="6" fill="{INK}"/>'
            f'<circle cx="-22.4" cy="-28" r="2" fill="{WHITE}"/><circle cx="25.6" cy="-28" r="2" fill="{WHITE}"/>'
            f'<g fill="none" stroke="{INK}" stroke-linecap="round" stroke-width="2.2">'
            f'<path d="M-12 -4Q-6 3 0 -3Q6 3 12 -4"/><path d="M-21 -12L-33 -15M-21 -6L-33 -5M21 -12L33 -15M21 -6L33 -5"/></g>')
    ribbon = (f'<path d="M-92 10H-78V46H-92L-84 28Z" fill="{BLUSH}"/><path d="M92 10H78V46H92L84 28Z" fill="{BLUSH}"/>'
              + rect(-80, 8, 160, 36, 8, WHITE) + text(0, 33, 'APPROVED', 19, DEEP, 800, 'middle', ' letter-spacing="1.5"'))
    return (wax + drip + f'<circle r="54" fill="{CORAL}"/>'
            f'<circle r="48" fill="none" stroke="{BLUSH}" stroke-width="2" stroke-dasharray="1 7" stroke-linecap="round" opacity=".9"/>'
            f'<path d="M-40 -30A50 50 0 0 1 -6 -50" fill="none" stroke="{WHITE}" stroke-width="5" stroke-linecap="round" opacity=".35"/>'
            + face + ribbon)


def card_svg(th, x, y, w, h, hint=True, say_cls=None, ok_cls=None, mic_cls=None):
    """The approval card: 'Allow controlling Notes?'"""
    s = (rect(x - 2, y + 12, w + 4, h, 26, th['shadow'], f' opacity="{th["shadow_op"] * 1.3}"') +
         rect(x, y, w, h, 24, th['win']) +
         rect(x + 24, y, w - 48, 7, 3.5, CORAL))
    s += (f'<circle cx="{x + 40}" cy="{y + 40}" r="9" fill="none" stroke="{CORAL}" stroke-width="4.5"/>' +
          text(x + 58, y + 46, 'Lookma needs your OK', 16, CORAL, 700))
    s += notes_icon(x + 58, y + 102, 52)
    s += text(x + 100, y + 96, 'Allow controlling Notes?', 28, th['text'], 700)
    s += text(x + 100, y + 124, 'It wants to write your sushi list.', 18, th['sub'], 500)
    if hint:
        s += f'<path d="M{x + 28} {y + 150}H{x + w - 28}" stroke="{th["winline"]}" stroke-width="1.5"/>'
        if mic_cls:
            s += G(mic_cls, f'<circle cx="{x + 50}" cy="{y + 190}" r="22" fill="none" stroke="{CORAL}" stroke-width="3"/>')
        s += rect(x + 28, y + 168, 44, 44, 22, th['hl']) + mic(x + 50, y + 191, CORAL, 1.0)
        s += G(say_cls, text(x + 86, y + 197, 'Say “yes, I approve”', 20, th['text'], 700))
        if ok_cls:
            s += G(ok_cls, text(x + 86, y + 197, 'Approved by your voice ✓', 20, DEEP, 700), ' opacity="0"')
    return s


# ---------------------------------------------------------------- dock icons
def notes_icon(cx, cy, size=60):
    s = size / 60
    x, y = -30, -30
    inner = (rect(x, y, 60, 60, 15, '#FFFFFF', ' stroke="#EADFD6" stroke-width="1.5"') +
             f'<path d="M{x} {y + 19}V{y + 15}A15 15 0 0 1 {x + 15} {y}H{x + 45}A15 15 0 0 1 {x + 60} {y + 15}V{y + 19}Z" fill="{YELLOW}"/>' +
             ''.join(f'<path d="M{x + 12} {y + 30 + i * 9}H{x + 48 - (i == 2) * 14}" stroke="#E2D9D1" stroke-width="3" stroke-linecap="round"/>' for i in range(3)))
    return at(cx, cy, inner, f' scale({fmt(s, 3)})')


def maps_icon(cx, cy):
    x, y = cx - 30, cy - 30
    return (rect(x, y, 60, 60, 15, '#CFEFC5') +
            f'<path d="M{x + 38} {y}H{x + 45}A15 15 0 0 1 {x + 60} {y + 15}V{y + 60}H{x + 50}Q{x + 34} {y + 30} {x + 38} {y}Z" fill="#A6D8F7"/>' +
            f'<path d="M{x} {y + 46}L{x + 60} {y + 14}" stroke="#FFFFFF" stroke-width="6"/>' +
            f'<path d="M{x + 18} {y}V{y + 60}" stroke="#FFFFFF" stroke-width="4"/>' +
            at(cx - 3, cy + 10, f'<path d="M0 0C-4 -7 -11 -12 -11 -19A11 11 0 1 1 11 -19C11 -12 4 -7 0 0Z" fill="{CORAL}"/><circle cy="-19" r="4.5" fill="#FFFFFF"/>'))


def dock_icons(th, xs, cy):
    out = []
    folder = lambda cx: (rect(cx - 30, cy - 30, 60, 60, 15, '#8CCBFA') +
                         rect(cx - 21, cy - 17, 18, 9, 3, '#E6F4FF') + rect(cx - 21, cy - 12, 42, 30, 6, '#E6F4FF') +
                         rect(cx - 21, cy - 6, 42, 24, 6, '#FFFFFF'))
    cal = lambda cx: (rect(cx - 30, cy - 30, 60, 60, 15, '#FFFFFF', ' stroke="#EADFD6" stroke-width="1.5"') +
                      f'<path d="M{cx - 30} {cy - 12}V{cy - 15}A15 15 0 0 1 {cx - 15} {cy - 30}H{cx + 15}A15 15 0 0 1 {cx + 30} {cy - 15}V{cy - 12}Z" fill="{CORAL}"/>' +
                      text(cx, cy - 16, 'NOV', 10, '#FFFFFF', 800, 'middle', ' letter-spacing="1"') +
                      text(cx, cy + 19, '19', 27, INK, 700, 'middle'))
    weather = lambda cx: (rect(cx - 30, cy - 30, 60, 60, 15, '#9FD3FF') +
                          f'<circle cx="{cx + 8}" cy="{cy - 7}" r="11" fill="{YELLOW}"/>' +
                          f'<g fill="#FFFFFF"><circle cx="{cx - 8}" cy="{cy + 8}" r="9"/><circle cx="{cx + 4}" cy="{cy + 5}" r="11"/>'
                          f'<rect x="{cx - 17}" y="{cy + 7}" width="32" height="10" rx="5"/></g>')
    gear_teeth = ''.join(f'<rect x="-4" y="-19" width="8" height="10" rx="2" fill="#7E7988" transform="rotate({a})"/>' for a in range(0, 360, 45))
    settings = lambda cx: (rect(cx - 30, cy - 30, 60, 60, 15, '#D3CFDA') +
                           at(cx, cy, gear_teeth + '<circle r="13" fill="#7E7988"/><circle r="5.5" fill="#D3CFDA"/>'))
    return [folder(xs[0]), maps_icon(xs[1], cy), notes_icon(xs[2], cy), cal(xs[3]), weather(xs[4]), settings(xs[5])]


# ---------------------------------------------------------------- demo
def nose_at(ax, ay, s, f=1):
    return ax + 96 * f * s, ay - 423.4 * s


def build_demo(th, dark):
    c = Clock(24.0, 'd')
    W, H = 1200, 750
    tTalk, tFlick, tMaps, tOk, tNotes, tAside, tOut = 1.9, 5.35, 7.0, 10.85, 14.45, 17.6, 20.3
    HOME, S0 = (106, 748), .52
    NOSE0 = nose_at(*HOME, S0)
    EDGE = (1118, 748)
    NOSE_EDGE = nose_at(*EDGE, S0, -1)
    TITLE = (905, 652, .95)
    DOCK_Y = 699
    DX = [415, 489, 563, 637, 711, 785]
    MAPS_IC, NOTES_IC = (DX[1], DOCK_Y), (DX[2], DOCK_Y)

    body = []
    # ------------------------------------------------ desktop
    tw = ''
    for i, (x, y, r) in enumerate([(120, 120, 7), (330, 70, 5), (1080, 90, 6), (980, 300, 4), (60, 380, 5),
                                   (560, 560, 4), (1140, 420, 6), (250, 600, 4), (700, 110, 4)]):
        d = 2.6 + (i % 4) * .7
        cls = c.loop([(0, T(0, 0, 0, .2, opacity=.2)), (d * .5, T(0, 0, 45, 1, opacity=.9), SINE), (d, T(0, 0, 90, .2, opacity=.2))], d)
        tw += at(x, y, G(cls, f'<path d="{spark_d(r)}" fill="{th["twinkle"]}"/>'))
    body.append(
        f'<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{th["bg1"]}"/>'
        f'<stop offset="1" stop-color="{th["bg2"]}"/></linearGradient>'
        f'<clipPath id="mapclip"><path d="M590 106H1010V520A20 20 0 0 1 990 540H590Z"/></clipPath></defs>'
        f'<rect width="{W}" height="{H}" fill="url(#bg)"/>'
        f'<circle cx="170" cy="190" r="270" fill="{th["blob1"]}" opacity=".6"/>'
        f'<circle cx="1060" cy="640" r="310" fill="{th["blob2"]}" opacity=".6"/>'
        f'<circle cx="990" cy="110" r="170" fill="{th["blob3"]}" opacity=".55"/>'
        f'<ellipse cx="600" cy="905" rx="900" ry="300" fill="{WHITE}" opacity="{.18 if not dark else .04}"/>' + tw)
    # menu bar
    lm_glow = c.anim([(0, O(0)), (tTalk + .45, O(0)), (tTalk + .6, O(1)), (tOut, O(1)), (tOut + .3, O(0))])
    body.append(
        rect(0, 0, W, 32, 0, th['menubar'], f' opacity="{th["menubar_op"]}"') +
        f'<circle cx="26" cy="16" r="6.5" fill="none" stroke="{th["menu_text"]}" stroke-width="3"/>' +
        ''.join(text(x, 22, s, 15, th['menu_text'], 700 if i == 0 else 500) for i, (x, s) in enumerate(zip([52, 138, 182, 224, 270], ['Desktop', 'File', 'Edit', 'View', 'Window']))) +
        G(lm_glow, f'<circle cx="1062" cy="16" r="12" fill="{CORAL}" opacity=".28"/>') +
        f'<circle cx="1062" cy="16" r="6" fill="none" stroke="{CORAL}" stroke-width="3.2"/>' +
        text(1176, 22, 'Thu 9:41', 15, th['menu_text'], 600, 'end'))
    # dock
    icons = dock_icons(th, DX, DOCK_Y)

    def bounce_frames(t0, hgt=(28, 13, 5)):
        fr = [(t0, T(0, 0), OUTE)]
        t = t0
        for i, hh in enumerate(hgt):
            d = .2 - i * .04
            fr += [(t + d, T(0, -hh), INE), (t + 2 * d, T(0, 0, 0, 1.08, .92), OUTE), (t + 2 * d + .06, T(0, 0), OUTE)]
            t += 2 * d + .06
        return fr
    maps_b = c.anim(bounce_frames(tFlick + 1.15), origin=f'{DX[1]}px {DOCK_Y + 30}px')
    notes_b = c.anim(bounce_frames(tNotes + .5, (24, 10)), origin=f'{DX[2]}px {DOCK_Y + 30}px')
    icons[1] = G(maps_b, icons[1])
    icons[2] = G(notes_b, icons[2])
    dot_m = c.anim([(0, O(0)), (tFlick + 1.6, O(0)), (tFlick + 1.7, O(1)), (23.4, O(1)), (23.7, O(0))])
    dot_n = c.anim([(0, O(0)), (tNotes + .9, O(0)), (tNotes + 1.0, O(1)), (23.4, O(1)), (23.7, O(0))])
    body.append(
        rect(371, 660, 458, 80, 26, th['dock'], f' opacity="{th["dock_op"]}" stroke="{th["dock_line"]}" stroke-width="1.5"') +
        ''.join(rect(x - 29, DOCK_Y - 25, 58, 58, 15, th['shadow'], f' opacity="{th["shadow_op"]}"') for x in DX) +
        ''.join(icons) +
        G(dot_m, f'<circle cx="{DX[1]}" cy="735" r="3" fill="{th["text"]}" opacity=".55"/>') +
        G(dot_n, f'<circle cx="{DX[2]}" cy="735" r="3" fill="{th["text"]}" opacity=".55"/>'))

    # ------------------------------------------------ Maps window
    mx, my, mw, mh = 290, 60, 720, 480
    maps_close = tOut + .25
    mapwin = c.anim(window_frames(tFlick + 1.6, maps_close), origin=f'{MAPS_IC[0]}px {MAPS_IC[1]}px')
    roads = th['road']
    boat_bob = c.loop([(0, T(0, 0, -3)), (1.3, T(0, -4, 3), SINE), (2.6, T(0, 0, -3), SINE)], 2.6, origin='0px 0px')
    mapart = (
        f'<g clip-path="url(#mapclip)"><rect x="590" y="106" width="420" height="474" fill="{th["land"]}"/>'
        + rect(612, 128, 74, 56, 14, th['park']) + rect(724, 470, 64, 48, 12, th['park'])
        + ''.join(f'<circle cx="{x}" cy="{y}" r="7" fill="{th["park"]}" opacity=".0"/>' for x, y in [])
        + f'<g stroke="{roads}" stroke-linecap="round" fill="none">'
          f'<path d="M590 205H905M590 425H888M700 106V580M792 106V580" stroke-width="8"/>'
          f'<path d="M598 572L896 332" stroke-width="15"/>'
          f'<path d="M917 106C897 202 887 262 894 332C900 402 877 472 862 580" stroke-width="11"/></g>'
        f'<path d="M934 106C914 202 904 262 911 332C917 402 894 472 879 580H1010V106Z" fill="{th["water"]}"/>'
        f'<g fill="none" stroke="{WHITE}" stroke-width="3" stroke-linecap="round" opacity=".7">'
        f'<path d="M944 160q7 -6 14 0t14 0"/><path d="M958 410q7 -6 14 0t14 0"/><path d="M930 520q7 -6 14 0t14 0"/></g>'
        + at(968, 262, G(boat_bob, f'<path d="M-22 0H22L15 11H-15Z" fill="{WHITE}"/><path d="M-18 4H18" stroke="{CORAL}" stroke-width="3"/>'
                                    f'<rect x="-9" y="-11" width="18" height="11" rx="3" fill="{WHITE}"/><rect x="-5" y="-7" width="10" height="4" rx="2" fill="#9FD3FF"/>'))
        + f'<g fill="{th["bldg"]}"><rect x="884" y="322" width="38" height="16" rx="3"/><rect x="898" y="296" width="10" height="28" rx="2"/>'
          f'<path d="M897 297L903 288L909 297Z"/></g><circle cx="903" cy="306" r="2.8" fill="{WHITE}"/>'
        + text(903, 362, 'Ferry Building', 15, th['text'], 700, 'middle', f' stroke="{th["land"]}" stroke-width="5" paint-order="stroke" stroke-linejoin="round"')
        + '</g>')
    # pins
    PINS = [(795, 255), (848, 462), (712, 372)]
    pins = ''
    ring_hops = [tMaps + 2.45, tMaps + 2.95, tMaps + 3.45]  # ring lands on result i
    for i, (px, py) in enumerate(PINS):
        t0 = tMaps + 2.0 + i * .13
        drop = c.anim([(t0, T(0, -170, opacity=0)), (t0 + .01, T(0, -170, opacity=1), INE), (t0 + .3, T(0, 0))])
        tl = ring_hops[i] + .05
        sq = c.anim([(t0 + .3, T(0, 0, 0, 1, 1)), (t0 + .31, T(0, 0, 0, 1.3, .7), OUTE), (t0 + .45, T(0, 0, 0, .9, 1.12), OUTE),
                     (t0 + .6, T(0, 0, 0, 1, 1)), (tl, T(0, 0, 0, 1, 1), OUTE), (tl + .12, T(0, 0, 0, 1.28, 1.28), SPRING), (tl + .45, T(0, 0, 0, 1, 1))])
        shadow = c.anim([(t0, T(0, 0, 0, 0)), (t0 + .3, T(0, 0, 0, 0), OUTE), (t0 + .45, T(0, 0, 0, 1))])
        pins += at(px, py,
                   G(shadow, f'<ellipse rx="10" ry="3.5" fill="{INK}" opacity=".18"/>') +
                   G(drop, G(sq, f'<path d="M0 0C-6 -10 -21 -20 -21 -36A21 21 0 1 1 21 -36C21 -20 6 -10 0 0Z" fill="{CORAL}"/>'
                                 f'<circle cy="-36" r="15" fill="{WHITE}"/>'
                                 f'<text y="-29.5" font-size="18" text-anchor="middle">🍣</text>'))) + sparkle(c, px + 22, py - 58, t0 + .32, 9, YELLOW)
    # sidebar: search + results
    typed = 'sushi near Ferry Building'
    t_type0, t_type1 = tMaps + 1.2, tMaps + 1.9
    cover = c.anim([(t_type0, {'transform': 'scale(1,1)'}, 'steps(25,end)'), (t_type1, {'transform': 'scale(0,1)'})], origin='572px 0px')
    caret = c.anim([(t_type0, T(0, 0, opacity=0)), (t_type0 + .01, T(0, 0, opacity=1), 'steps(25,end)'), (t_type1, T(204, 0, opacity=1)),
                    (t_type1 + .25, T(204, 0, opacity=0)), (t_type1 + .5, T(204, 0, opacity=1)), (t_type1 + .75, T(204, 0, opacity=0))])
    ph = c.anim([(0, O(1)), (t_type0 - .05, O(1)), (t_type0, O(0))])
    search = (rect(306, 118, 268, 44, 22, th['field']) +
              f'<circle cx="331" cy="138" r="7" fill="none" stroke="{th["sub"]}" stroke-width="2.6"/><path d="M336 143L341 148" stroke="{th["sub"]}" stroke-width="2.6" stroke-linecap="round"/>' +
              text(350, 146, typed, 17, th['text'], 500) +
              G(cover, rect(348, 124, 224, 32, 0, th['field'])) +
              G(ph, text(350, 146, 'Search Maps', 17, th['sub'], 500)) +
              G(caret, rect(349, 128, 2.5, 24, 1, CORAL)))
    results = ''
    names = [('Umi Counter', '★ 4.8 · 0.2 mi'), ('Saba & Rice', '★ 4.7 · 0.3 mi'), ('Ferry Roll', '★ 4.6 · 0.5 mi')]
    for i, (nm, meta) in enumerate(names):
        ry = 178 + i * 86
        t0 = tMaps + 2.0 + i * .12
        slide = c.anim([(t0, T(-24, 0, opacity=0)), (t0 + .01, T(-24, 0, opacity=0), SPRING), (t0 + .45, T(0, 0, opacity=1))])
        th_ = ring_hops[i]
        hl = c.anim([(0, O(0)), (th_, O(0)), (th_ + .12, O(1)), (th_ + .5, O(1)), (th_ + .8, O(0))])
        results += G(slide, rect(306, ry, 268, 74, 16, th['field']) + G(hl, rect(306, ry, 268, 74, 16, th['hl'])) +
                     f'<circle cx="338" cy="{ry + 37}" r="21" fill="{WHITE}"/>' +
                     f'<text x="338" y="{ry + 44}" font-size="20" text-anchor="middle">🍣</text>' +
                     text(370, ry + 32, nm, 18, th['text'], 700) + text(370, ry + 56, meta, 15, th['sub'], 500))
    body.append(G(mapwin, window(th, mx, my, mw, mh, 'Maps') + mapart + pins + search + results))

    # ------------------------------------------------ Notes window
    nx, ny, nw, nh = 612, 132, 500, 300
    notewin = c.anim(window_frames(tNotes + .8, maps_close + .05), origin=f'{NOTES_IC[0]}px {NOTES_IC[1]}px')
    lines = [('Sushi near the Ferry Building', 25, 700, 246), ('🍣 Umi Counter · 0.2 mi', 21, 400, 292),
             ('🍣 Saba & Rice · 0.3 mi', 21, 400, 334), ('🍣 Ferry Roll · 0.5 mi', 21, 400, 376)]
    widths = [345, 225, 220, 196]
    t_write = [tNotes + 1.45, tNotes + 2.0, tNotes + 2.45, tNotes + 2.9]
    ncontent = ''
    for (s, size, wt, y), wd, tw0 in zip(lines, widths, t_write):
        n = max(10, len(s))
        dur = .42 if size < 25 else .5
        cv = c.anim([(tw0, {'transform': 'scale(1,1)'}, f'steps({n},end)'), (tw0 + dur, {'transform': 'scale(0,1)'})], origin=f'{666 + wd + 6}px 0px')
        ncontent += text(666, y, s, size, th['text'], wt) + G(cv, rect(662, y - size, wd + 10, size + 10, 0, th['win']))
    ncontent += text(nx + nw / 2, 204, 'Today at 9:41', 14, th['sub'], 600, 'middle')
    body.append(G(notewin, window(th, nx, ny, nw, nh, 'Notes', bar=th['notesbar']) + ncontent))

    # ------------------------------------------------ Draft window (you type here)
    dx, dy, dw, dh = 140, 150, 430, 268
    draftwin = c.anim(window_frames(tAside, maps_close + .1, s0=.5), origin=f'{dx + dw / 2}px {dy + dh / 2}px')
    dlines = [('Weekend plans', 22, 700, 236, 160), ('ferry ride at 10, then lunch', 19, 400, 276, 225),
              ('bring a warm jacket', 19, 400, 310, 170)]
    dtimes = [(tAside + .45, .5), (tAside + 1.0, .75), (tAside + 1.85, .5)]
    dcontent = ''
    for (s, size, wt, y, wd), (t0, dur) in zip(dlines, dtimes):
        cv = c.anim([(t0, {'transform': 'scale(1,1)'}, f'steps({len(s)},end)'), (t0 + dur, {'transform': 'scale(0,1)'})], origin=f'{170 + wd + 6}px 0px')
        dcontent += text(170, y, s, size, th['text'], wt) + G(cv, rect(166, y - size, wd + 10, size + 9, 0, th['win']))
    dotsvis = c.anim([(0, O(0)), (tAside + .4, O(0)), (tAside + .5, O(1)), (tAside + 2.4, O(1)), (tAside + 2.55, O(0))])
    dots = ''
    for i in range(3):
        cls = c.loop([(0, T(0, 0)), (.15 + i * .1, T(0, 0), SINE), (.3 + i * .1, T(0, -6), SINE), (.45 + i * .1, T(0, 0)), (.9, T(0, 0))], .9)
        dots += G(cls, f'<circle cx="{190 + i * 14}" cy="358" r="4.5" fill="{th["sub"]}"/>')
    dcontent += G(dotsvis, rect(170, 342, 62, 32, 16, th['field']) + dots + text(244, 363, 'you’re typing…', 15, th['sub'], 600))
    body.append(G(draftwin, window(th, dx, dy, dw, dh, 'Draft') + dcontent))

    # ------------------------------------------------ dim + approval card + stamp
    dim = c.anim([(0, O(0)), (tOk + .3, O(0)), (tOk + .6, O(th['dim_op'])), (tNotes - .05, O(th['dim_op'])), (tNotes + .3, O(0))])
    body.append(G(dim, rect(0, 0, W, H, 0, th['dim'])))
    cx0, cy0, cw, ch = 420, 196, 470, 236
    ccx, ccy = cx0 + cw / 2, cy0 + ch / 2
    t_card, t_slam = tOk + .4, tOk + 2.5
    t_close = tNotes + .0
    card = c.anim([(t_card, T(0, 0, 0, .4, opacity=0)), (t_card + .01, T(0, 0, 0, .4, opacity=1), SPRING), (t_card + .45, T(0, 0, 0, 1)),
                   (t_close, T(0, 0, 0, 1), INE), (t_close + .4, T(NOTES_IC[0] - ccx, NOTES_IC[1] - ccy, 0, .06, opacity=.0))],
                  origin=f'{ccx}px {ccy}px')
    shake = c.anim([(t_slam, T(0, 0)), (t_slam + .05, T(-7, 4)), (t_slam + .1, T(6, -3)), (t_slam + .15, T(-4, 2)), (t_slam + .2, T(3, -1)),
                    (t_slam + .26, T(-1, 0)), (t_slam + .32, T(0, 0))])
    stamp = c.anim([(t_slam - .25, T(0, 0, -38, 2.7, opacity=0)), (t_slam - .24, T(0, 0, -38, 2.7, opacity=.0), INE),
                    (t_slam, T(0, 0, -12, .86, opacity=1), OUTE), (t_slam + .1, T(0, 0, -9, 1.08), SINE), (t_slam + .24, T(0, 0, -10, 1))])
    SX, SY = cx0 + cw - 58, cy0 + ch - 34
    lines_burst = ''
    for i in range(10):
        a = i * 36 + 8
        cls = c.anim([(t_slam, T(0, 0, a, .4, opacity=0)), (t_slam + .01, T(0, 0, a, .5, opacity=1), OUTE), (t_slam + .4, T(0, 0, a, 1.25, opacity=0))])
        lines_burst += G(cls, f'<path d="M88 0H112" stroke="{CORAL if i % 2 else YELLOW}" stroke-width="7" stroke-linecap="round"/>')
    puff = c.anim([(t_slam, T(0, 0, 0, .5, opacity=0)), (t_slam + .01, T(0, 0, 0, .6, opacity=.5), OUTE), (t_slam + .5, T(0, 0, 0, 1.5, opacity=0))])
    say_c = c.anim([(0, O(1)), (t_slam, O(1)), (t_slam + .12, O(0))])
    ok_c = c.anim([(0, O(0)), (t_slam + .1, O(0)), (t_slam + .25, O(1))])
    t_yes = tOk + 1.35
    mic_c = c.anim([f for i in range(3) for f in ((t_yes + i * .3, T(0, 0, 0, 1, opacity=0)), (t_yes + i * .3 + .01, T(0, 0, 0, 1, opacity=.8), OUTE),
                                                  (t_yes + i * .3 + .5, T(0, 0, 0, 1.6, opacity=0)))], origin=f'{cx0 + 50}px {cy0 + 190}px')
    body.append(G(card, G(shake, card_svg(th, cx0, cy0, cw, ch, say_cls=say_c, ok_cls=ok_c, mic_cls=mic_c) +
                          at(SX, SY, G(puff, f'<circle r="80" fill="{BLUSH}"/>') + lines_burst + G(stamp, stamp_svg())))))

    # ------------------------------------------------ keycaps (talk)
    kx = [548, 652]
    keys = ''
    for i, (lab, sub) in enumerate([('⌥', 'option'), ('fn', '')]):
        t0 = tTalk + i * .1
        kp = c.anim([(t0, T(0, 0, 0, 0)), (t0 + .01, T(0, 0, 0, .2), SPRING), (t0 + .4, T(0, 0, 0, 1)),
                     (tFlick - .1, T(0, 0, 0, 1), INE), (tFlick + .15, T(0, 0, 0, 0))], origin=f'{kx[i]}px 470px')
        tp = tTalk + .45
        kpress = c.anim([(tp, T(0, 0, 0, 1, 1), OUTE), (tp + .1, T(0, 9, 0, 1.03, .9), SPRING), (tp + .3, T(0, 7, 0, 1, .94)),
                         (tFlick - .35, T(0, 7, 0, 1, .94), SPRING), (tFlick - .1, T(0, 0, 0, 1, 1))], origin=f'{kx[i]}px 470px')
        keys += keycap(th, kx[i], 427, lab, sub, kp, kpress)
    plus = c.anim(pop(c, tTalk + .05, tFlick - .1), origin='600px 427px')
    hold_lbl = c.anim(pop(c, tTalk + .3, tFlick - .1, s0=.7), origin='600px 506px')
    ripple = ''
    for i in range(2):
        tr = tTalk + .55 + i * .5
        cls = c.anim([(tr, T(0, 0, 0, .9, opacity=0)), (tr + .01, T(0, 0, 0, .9, opacity=.55), OUTE), (tr + .6, T(0, 0, 0, 1.6, opacity=0))], origin='600px 430px')
        ripple += G(cls, rect(478, 374, 244, 108, 54, 'none', f' stroke="{CORAL}" stroke-width="3.5"'))
    body.append(ripple + keys + G(plus, text(600, 437, '+', 30, th['sub'], 600, 'middle')) +
                G(hold_lbl, text(600, 512, 'hold ⌥ fn and talk', 18, th['sub'], 600, 'middle')))

    # ------------------------------------------------ user bubbles
    # 1) the request
    bx, by, bw, bh = 296, 208, 640, 112
    tipx, tipy = 600, 372
    b1 = c.anim(pop(c, tTalk + .65, tFlick + .05, s0=.5), origin=f'{tipx}px {tipy}px')
    l1 = 'Find 3 sushi spots near the Ferry Building 🍣'
    l2 = 'and put them in a note.'
    t1a = tTalk + .85
    cv1 = c.anim([(t1a, {'transform': 'scale(1,1)'}, 'steps(30,end)'), (t1a + 1.05, {'transform': 'scale(0,1)'})], origin=f'{bx + 84 + 548}px 0px')
    cv2 = c.anim([(t1a + 1.1, {'transform': 'scale(1,1)'}, 'steps(14,end)'), (t1a + 1.55, {'transform': 'scale(0,1)'})], origin=f'{bx + 84 + 290}px 0px')
    bub1 = (f'<path d="{bubble_d(bx, by, bw, bh, 28, 612, tipx, tipy - 28)}" fill="{th["ububble"]}"/>' +
            rect(bx + 22, by + 30, 48, 48, 24, th['hl']) + mic(bx + 46, by + 56, CORAL, 1.1) +
            text(bx + 86, by + 50, l1, 27, th['utext'], 500) + text(bx + 86, by + 88, l2, 27, th['utext'], 500) +
            G(cv1, rect(bx + 82, by + 22, 552, 36, 0, th['ububble'])) + G(cv2, rect(bx + 82, by + 62, 300, 36, 0, th['ububble'])) +
            eq_bars(c, bx + bw - 64, by + 88, t1a, t1a + 1.6, CORAL))
    body.append(G(b1, bub1))
    # 2) yes, I approve
    t_yes = tOk + 1.35
    ux, uy, uw, uh = 898, 246, 284, 62
    b2 = c.anim(pop(c, t_yes, tNotes - .1, s0=.5), origin=f'{ux + uw - 40}px {uy + uh + 22}px')
    bub2 = (f'<path d="{bubble_d(ux, uy, uw, uh, 24, ux + uw - 56, ux + uw - 30, uy + uh + 22)}" fill="{th["ububble"]}"/>' +
            mic(ux + 30, uy + 33, CORAL, .95) + text(ux + 52, uy + 40, 'Yes, I approve.', 24, th['utext'], 700) +
            eq_bars(c, ux + 228, uy + 31, t_yes + .1, t_yes + .9, CORAL, n=3, hmax=16))
    body.append(G(b2, bub2))
    # mic pulse on the card hint while the user speaks
    # ------------------------------------------------ yellow tab
    t_tab = tAside + 1.85
    tab = c.anim([(t_tab, T(220, 0), SPRING), (t_tab + .45, T(0, 0)), (tOut + .2, T(0, 0), INE), (tOut + .5, T(220, 0))])
    body.append(G(tab, rect(1030, 438, 200, 46, 16, th['shadow'], f' opacity="{th["shadow_op"]}" transform="translate(0 5)"') +
                  rect(1030, 438, 200, 46, 16, YELLOW) +
                  f'<rect x="1048" y="451" width="5" height="20" rx="2" fill="{INK}"/><rect x="1058" y="451" width="5" height="20" rx="2" fill="{INK}"/>' +
                  text(1073, 468, 'I’ll wait 🦭', 19, INK, 700)))

    # ------------------------------------------------ ghost cursor
    cp = Mover(760, 330, op=0)
    cp.move(tFlick + 1.9, tFlick + 2.05, op=1)
    cp.move(tMaps + .6, tMaps + 1.1, x=346, y=146, ease=ease_spring)
    for i, t0 in enumerate(ring_hops):
        cp.move(t0 - .05, t0 + .3, x=356, y=228 + i * 86, ease=ease_spring)
    cp.move(tOk + .05, tOk + .55, x=576, y=712, ease=ease_spring)
    cp.hold(tNotes + 1.25)
    cp.move(tNotes + 1.25, tNotes + 1.6, x=650, y=250, ease=ease_spring)
    for i, t0 in enumerate(t_write[1:]):
        cp.move(t0 - .1, t0 + .2, y=300 + i * 42, ease=ease_spring)
    cp.move(tAside + .1, tAside + .35, op=0)
    curpos = c.anim(cp.frames())
    clicks = [tMaps + 1.12, tNotes + .42]
    cfr = [(0, {'transform': 'scale(1)'})]
    for tc in clicks:
        cfr += [(tc, {'transform': 'scale(1)'}), (tc + .07, {'transform': 'scale(.78)'}), (tc + .2, {'transform': 'scale(1)'})]
    click = c.anim(cfr)
    cursor = G(curpos, G(click, f'<path d="M0 0V27L7 20.6L11.6 31.2L16.4 29.2L11.8 18.8H21.2Z" fill="{CORAL}" opacity=".22" transform="translate(-2 -2) scale(1.2)"/>'
                                f'<path d="M0 0V27L7 20.6L11.6 31.2L16.4 29.2L11.8 18.8H21.2Z" fill="{WHITE}" fill-opacity=".92" stroke="{DEEP}" stroke-width="2.2" stroke-linejoin="round"/>'))
    click_rings = ''
    for tc, (x, y) in zip(clicks, [(346, 146), (576, 712)]):
        cls = c.anim([(tc, T(0, 0, 0, .2, opacity=0)), (tc + .01, T(0, 0, 0, .3, opacity=.8), OUTE), (tc + .45, T(0, 0, 0, 1.4, opacity=0))])
        click_rings += at(x, y, G(cls, f'<circle r="20" fill="none" stroke="{CORAL}" stroke-width="3"/>'))

    # ------------------------------------------------ flying ring
    rp = Mover(*NOSE0, k=1, op=0, fps=30)
    t_launch = tFlick + .17
    rp.set(t_launch - .01, op=1)
    rp.move(t_launch, t_launch + .95, x=MAPS_IC[0], y=MAPS_IC[1], k=2.05, h=320)
    rp.settle(t_launch + .95, .45, .12)
    rp.hold(tMaps + .45)
    rp.move(tMaps + .45, tMaps + .95, x=331, y=140, k=1.5, h=150)
    rp.settle(tMaps + .95, .4, .14)
    for i, t0 in enumerate(ring_hops):
        rp.move(t0 - .3, t0, x=338, y=215 + i * 86, k=1.35, h=46)
        rp.settle(t0, .36, .16)
    rp.move(tOk, tOk + .55, x=NOTES_IC[0], y=NOTES_IC[1], k=2.05, h=170)
    rp.settle(tOk + .55, .4, .12)
    # rides the Notes launch bounce
    rp.hold(tNotes + .5)
    rp.move(tNotes + .5, tNotes + .7, y=NOTES_IC[1] - 28, ease=ease_out)
    rp.move(tNotes + .7, tNotes + .9, y=NOTES_IC[1], ease=ease_in)
    rp.move(tNotes + 1.1, tNotes + 1.5, x=638, y=237, k=.95, h=170)
    rp.settle(tNotes + 1.5, .36, .14)
    for i, t0 in enumerate(t_write[1:]):
        rp.move(t0 - .2, t0, x=638, y=285 + i * 42, h=26)
        rp.settle(t0, .3, .14)
    rp.move(tAside + .15, tAside + .5, k=.9, op=.35, ease=ease_out)
    rp.hold(tOut)
    rp.move(tOut, tOut + .6, x=NOSE_EDGE[0], y=NOSE_EDGE[1], k=1, op=1, h=220)
    rp.set(tOut + .6, op=0)
    ringpos = c.anim(rp.frames())
    ringstroke = c.anim(rp.extra_frames(lambda k, op: {'stroke-width': fmt((9.7 - 1.3 * min(max((k - 1) / .6, 0), 1)) / k, 3)}))
    spin = c.anim([(t_launch, T(0, 0, 0), OUTE), (t_launch + .95, T(0, 0, 900)), (tMaps + .45, T(0, 0, 900), INOUT),
                   (tMaps + .95, T(0, 0, 1260)), (tOk, T(0, 0, 1260), INOUT), (tOk + .55, T(0, 0, 1620)),
                   (tNotes + 1.1, T(0, 0, 1620), INOUT), (tNotes + 1.5, T(0, 0, 1980)), (tOut, T(0, 0, 1980), INOUT),
                   (tOut + .6, T(0, 0, 2700)), (tOut + .7, T(0, 0, 0))])
    pulses = ''
    for i in range(4):
        tp = tOk + .75 + i * .62
        cls = c.anim([(tp, T(0, 0, 0, 1, opacity=0)), (tp + .01, T(0, 0, 0, 1, opacity=.7), OUTE), (tp + .7, T(0, 0, 0, 1.75, opacity=0))])
        pulses += G(cls, f'<circle r="18.4" fill="none" stroke="{CORAL}" stroke-width="2.2"/>')
    ring = G(ringpos, pulses + G(spin, G(ringstroke, f'<circle r="18.4" fill="none" stroke="{CORAL}"/>') +
                                 f'<circle cx="-12" cy="-12" r="2.6" fill="{WHITE}" opacity=".9"/>'))
    trail = ''
    for i, u in enumerate([.22, .42, .62, .8]):
        tt = t_launch + .95 * u
        x, y = rp.pos(tt)
        trail += sparkle(c, x + (8 if i % 2 else -8), y + 10, tt, 9 if i % 2 else 12, YELLOW if i % 2 == 0 else BLUSH)
    trail += burst(c, MAPS_IC[0], MAPS_IC[1], t_launch + .95, 4, 52, 10)
    for i, u in enumerate([.3, .55, .8]):
        tt = tOut + .6 * u
        x, y = rp.pos(tt)
        trail += sparkle(c, x, y + 12, tt, 10 if i % 2 else 13, YELLOW if i % 2 == 0 else BLUSH)
    body.append(trail + ring + cursor + click_rings)

    # ------------------------------------------------ title card
    t_iris = tOut + .7
    t_end = 23.25
    iris = c.anim([(t_iris, T(0, 0, 0, 0, opacity=1), OUTE), (t_iris + .7, T(0, 0, 0, 1)), (t_end + .2, T(0, 0, 0, 1, opacity=1)),
                   (t_end + .21, T(0, 0, 0, 0, opacity=0))])
    iris_out = c.anim([(0, T(0, 0, 0, 0, opacity=0)), (t_end + .19, T(0, 0, 0, 1, opacity=0)), (t_end + .2, T(0, 0, 0, 1, opacity=1), INOUT),
                       (t_end + .6, T(0, 0, 0, 0, opacity=1)), (t_end + .62, T(0, 0, 0, 0, opacity=0))])
    RING_T = nose_at(*TITLE)
    disc = c.anim(pop(c, t_iris + .25, t_end + .1, s0=.2, dur_out=.25), origin=f'{TITLE[0]}px 392px')
    wm = c.anim(pop(c, t_iris + .35, t_end, s0=.6, dur_out=.22), origin='110px 330px')
    tg = c.anim(pop(c, t_iris + .52, t_end, s0=.6, dur_out=.22), origin='114px 404px')
    sb = c.anim(pop(c, t_iris + .68, t_end, s0=.7, dur_out=.22), origin='116px 456px')
    pill = c.anim(pop(c, t_iris + .82, t_end, s0=.6, dur_out=.22), origin='116px 520px')
    title = (at(NOSE_EDGE[0], NOSE_EDGE[1], G(iris, f'<circle r="1400" fill="{th["title_bg"]}"/>')) +
             at(RING_T[0], RING_T[1], G(iris_out, f'<circle r="1150" fill="{th["title_bg"]}"/>')) +
             G(disc, f'<circle cx="{TITLE[0]}" cy="392" r="262" fill="{th["disc"]}"/>') +
             G(wm, text(104, 330, 'Lookma', 124, th['word'], 800, extra=' letter-spacing="-6"')) +
             G(tg, text(112, 404, 'Look ma, no hands.', 50, th['tagline'], 700, extra=' letter-spacing="-1"')) +
             G(sb, text(114, 456, 'Talk to your Mac. Watch it work.', 26, th['tagsub'], 500)) +
             G(pill, rect(114, 494, 252, 46, 23, 'none', f' stroke="{th["tagsub"]}" stroke-width="2" opacity=".5"') +
               text(240, 524, 'hold ⌥ fn and talk', 18, th['tagsub'], 600, 'middle')))
    title += sparkle(c, 560, 250, t_iris + 1.0, 14, YELLOW) + sparkle(c, 590, 300, t_iris + 1.15, 9, CORAL) + sparkle(c, 82, 250, t_iris + 1.25, 11, BLUSH)
    body.append(title)

    # ------------------------------------------------ Hands
    hp = Mover(HOME[0], 1010, k=S0, ox=256, oy=488)
    hp.hold(.12)
    hp.move(.12, .66, y=696, ease=ease_out)
    hp.move(.66, .92, y=HOME[1], ease=ease_in)
    # cheer when the pins drop
    t_cheer = tMaps + 2.35
    hp.move(t_cheer, t_cheer + .2, y=HOME[1] - 30, ease=ease_out)
    hp.move(t_cheer + .2, t_cheer + .4, y=HOME[1], ease=ease_in)
    # present the sign
    hp.move(tOk + .7, tOk + .88, y=HOME[1] - 26, ease=ease_out)
    hp.move(tOk + .88, tOk + 1.06, y=HOME[1], ease=ease_in)
    # happy hop on the stamp
    hp.move(t_slam + .08, t_slam + .3, y=HOME[1] - 46, ease=ease_out)
    hp.move(t_slam + .3, t_slam + .52, y=HOME[1], ease=ease_in)
    # scoot to the edge in three hops
    t_scoot = tAside + .4
    xs = [440, 780, EDGE[0]]
    for i, x in enumerate(xs):
        hp.move(t_scoot + i * .42, t_scoot + i * .42 + .38, x=x, h=44)
        hp.hold(t_scoot + i * .42 + .42)
    # catch the ring
    t_catch = tOut + .6
    hp.move(t_catch, t_catch + .14, y=EDGE[1] - 22, ease=ease_out)
    hp.move(t_catch + .14, t_catch + .3, y=EDGE[1], ease=ease_in)
    # hop into the title card
    t_jump = t_iris + .12
    hp.move(t_jump, t_jump + .62, x=TITLE[0], y=TITLE[1], k=TITLE[2], h=170)
    hp.hold(t_end)
    hp.move(t_end, t_end + .16, y=TITLE[1] - 36, ease=ease_out)
    hp.move(t_end + .16, t_end + .58, y=TITLE[1] + 620, ease=ease_in)
    hp.set(23.9, x=HOME[0], y=1010, k=S0)
    k = {}
    k['pos'] = c.anim(hp.frames())
    k['flip'] = c.anim([(0, {'transform': 'scale(1,1)'}), (t_scoot + 1.3, {'transform': 'scale(1,1)'}, INOUT),
                        (t_scoot + 1.55, {'transform': 'scale(-1,1)'}), (t_jump + .05, {'transform': 'scale(-1,1)'}, INOUT),
                        (t_jump + .35, {'transform': 'scale(1,1)'})])
    sq = [(0, T(0, 0, 0, 1, 1)), (.12, T(0, 0, 0, .9, 1.13)), (.66, T(0, 0, 0, .97, 1.04)), (.9, T(0, 0, 0, 1, 1)),
          (.93, T(0, 0, 0, 1.24, .8), OUTE), (1.08, T(0, 0, 0, .92, 1.09), SINE), (1.24, T(0, 0, 0, 1.04, .97), SINE), (1.4, T(0, 0, 0, 1, 1)),
          # perk up when the keys go down
          (tTalk + .5, T(0, 0, 0, 1, 1), OUTE), (tTalk + .62, T(0, 0, 0, .93, 1.1), SPRING), (tTalk + 1.0, T(0, 0, 0, 1, 1)),
          # flick
          (tFlick - .05, T(0, 0, 0, 1, 1), OUTE), (tFlick + .1, T(0, 0, -4, 1.1, .9), OUTE), (tFlick + .19, T(0, 0, 7, .92, 1.1), SPRING),
          (tFlick + .55, T(0, 0, 0, 1, 1)),
          # cheer
          (t_cheer - .06, T(0, 0, 0, 1.1, .9)), (t_cheer + .04, T(0, 0, 0, .93, 1.08)), (t_cheer + .38, T(0, 0, 0, 1, 1)),
          (t_cheer + .41, T(0, 0, 0, 1.14, .88), OUTE), (t_cheer + .56, T(0, 0, 0, 1, 1)),
          # present sign
          (tOk + .66, T(0, 0, 0, 1.08, .92)), (tOk + .72, T(0, 0, 0, .95, 1.06)), (tOk + 1.05, T(0, 0, 0, 1.12, .9), OUTE),
          (tOk + 1.2, T(0, 0, -5, 1, 1), SPRING), (t_slam, T(0, 0, -5, 1, 1)),
          # stamp joy
          (t_slam + .06, T(0, 0, 0, 1.1, .9)), (t_slam + .14, T(0, 0, 0, .92, 1.1)), (t_slam + .5, T(0, 0, 0, 1.18, .85), OUTE),
          (t_slam + .64, T(0, 0, 0, .97, 1.04), SINE), (t_slam + .78, T(0, 0, 0, 1, 1))]
    for i in range(3):
        t0 = t_scoot + i * .42
        sq += [(t0 - .04, T(0, 0, 0, 1.1, .9)), (t0 + .04, T(0, 0, 0, .93, 1.08)), (t0 + .34, T(0, 0, 0, .97, 1.04)),
               (t0 + .38, T(0, 0, 0, 1.16, .86), OUTE), (t0 + .48, T(0, 0, 0, 1, 1))]
    t_clap = tAside + 2.3
    sq += [(t_clap, T(0, 0, 0, 1, 1))]
    for i in range(3):
        sq += [(t_clap + .1 + i * .18, T(0, 0, 0, 1.04, .96)), (t_clap + .19 + i * .18, T(0, 0, 0, 1, 1))]
    sq += [(t_catch, T(0, 0, 0, 1, 1)), (t_catch + .02, T(0, 0, 0, 1.12, .88)), (t_catch + .12, T(0, 0, 0, .95, 1.06)),
           (t_catch + .3, T(0, 0, 0, 1.12, .9), OUTE), (t_catch + .45, T(0, 0, 0, 1, 1)),
           (t_jump - .05, T(0, 0, 0, 1.1, .9)), (t_jump + .05, T(0, 0, 0, .92, 1.1)), (t_jump + .58, T(0, 0, 0, 1, 1)),
           (t_jump + .64, T(0, 0, 0, 1.15, .87), OUTE), (t_jump + .8, T(0, 0, 0, .97, 1.03), SINE), (t_jump + .95, T(0, 0, 0, 1, 1))]
    k['sq'] = c.anim(sq)
    k['bob'] = c.loop([(0, T(0, 0)), (1.2, T(0, -9, 0, 1, 1.012), SINE), (2.4, T(0, 0), SINE)], 2.4)
    k['tail'] = c.loop([(0, T(0, 0, -7)), (.7, T(0, 0, 7), SINE), (1.4, T(0, 0, -7), SINE)], 1.4)
    k['head'] = c.anim([(0, T(0, 0, 0)), (tFlick - .05, T(0, 0, 0), OUTE), (tFlick + .1, T(0, 0, 8)), (tFlick + .19, T(0, 0, -10), SPRING),
                        (tFlick + .6, T(0, 0, 0)), (tOk + .6, T(0, 0, 0), SPRING), (tOk + .95, T(0, 0, -12)), (t_slam, T(0, 0, -12), SPRING),
                        (t_slam + .3, T(0, 0, 0))] +
                       [f for tw0 in t_write for f in ((tw0, T(0, 0, 0), SINE), (tw0 + .14, T(0, 0, 8), SINE), (tw0 + .32, T(0, 0, 0)))])
    blinks = [1.55, 4.3, 7.3, 9.7, 12.35, 16.2, 19.3, 22.35, 23.1]
    k['blink'] = c.anim(blink_frames(blinks))
    k['eyeperk'] = c.anim([(tTalk + .5, {'transform': 'scale(1)'}, SPRING), (tTalk + .7, {'transform': 'scale(1.32)'}),
                           (tTalk + 1.5, {'transform': 'scale(1.32)'}, SINE), (tTalk + 1.8, {'transform': 'scale(1)'})])
    joy = [(t_cheer, t_cheer + .7), (t_slam + .05, t_slam + 1.5), (t_clap, t_clap + .75), (t_catch, t_catch + .55)]
    hfr, efr = [(0, O(0))], [(0, O(1))]
    for a, b in joy:
        hfr += [(a, O(0)), (a + .03, O(1)), (b, O(1)), (b + .03, O(0))]
        efr += [(a, O(1)), (a + .03, O(0)), (b, O(0)), (b + .03, O(1))]
    k['happy'] = c.anim(hfr)
    k['eyes_on'] = c.anim(efr)
    fl = [(0, T(0, 0, 0))]
    fr = [(0, T(0, 0, 0))]
    for i, a in enumerate([-30, 10, -30, 6]):
        fr.append((1.5 + i * .12, T(0, 0, a), SINE))
    fr.append((1.5 + 4 * .12, T(0, 0, 0)))
    for i in range(3):
        t0 = t_clap + i * .18
        fl += [(t0, T(0, 0, 38), SINE), (t0 + .09, T(0, 0, 92), SINE)]
        fr += [(t0, T(0, 0, -38), SINE), (t0 + .09, T(0, 0, -92), SINE)]
    fl += [(t_clap + .6, T(0, 0, 0)), (t_catch, T(0, 0, 0), SPRING), (t_catch + .15, T(0, 0, 22)), (t_catch + .5, T(0, 0, 0))]
    fr += [(t_clap + .6, T(0, 0, 0)), (t_catch, T(0, 0, 0), SPRING), (t_catch + .15, T(0, 0, -30)), (t_catch + .5, T(0, 0, 0))]
    tw_ = t_jump + 1.0
    for i, a in enumerate([-30, 10, -30, 8, -24]):
        fr.append((tw_ + i * .13, T(0, 0, a), SINE))
    fr.append((tw_ + 5 * .13, T(0, 0, 0)))
    k['fl'], k['fr'] = c.anim(fl), c.anim(fr)
    k['nose'] = c.anim([(0, T(0, 0, 0, opacity=1)), (.92, T(0, 0, 0), OUTE), (1.05, T(0, -22, -14), INE), (1.2, T(0, 0, 9), SINE),
                        (1.36, T(0, 0, -5), SINE), (1.5, T(0, 0, 0)), (tFlick + .1, T(0, 0, 0), OUTE), (t_launch - .02, T(0, -10, 6, opacity=1)),
                        (t_launch, T(0, 0, 0, opacity=0)), (t_catch - .01, T(0, 0, 0, opacity=0)), (t_catch, T(0, -26, -16, opacity=1), SPRING),
                        (t_catch + .3, T(0, 0, 0)), (t_jump + .58, T(0, 0, 0), OUTE), (t_jump + .7, T(0, -16, 10), SINE), (t_jump + .86, T(0, 0, -4), SINE),
                        (t_jump + 1.0, T(0, 0, 0))])
    sign = c.anim([(tOk + .75, T(0, 0, 0, 0, opacity=1)), (tOk + .76, T(0, 0, -10, .2), SPRING), (tOk + 1.15, T(0, 0, 0, 1), SINE),
                   (tOk + 1.5, T(0, 0, 5, 1), SINE), (tOk + 1.85, T(0, 0, -4, 1), SINE), (tOk + 2.2, T(0, 0, 3, 1), SINE),
                   (t_slam - .05, T(0, 0, 0, 1), INE), (t_slam + .3, T(40, 80, 40, .4, opacity=0)), (t_slam + .31, T(0, 0, 0, 0, opacity=1))])
    sign_svg = G(sign, f'<path d="M0 0V-46" stroke="{DEEP}" stroke-width="9" stroke-linecap="round"/>' +
                 rect(-128, -128, 256, 86, 24, WHITE, f' stroke="{CORAL}" stroke-width="8"') +
                 text(0, -70, 'Approve?', 42, INK, 800, 'middle'))
    excl = c.anim(pop(c, tTalk + .55, tTalk + 1.6, s0=.2))
    excl_svg = at(450, 130, G(excl, f'<path d="M-6 -50L6 -50L4 6L-4 6Z" fill="{DEEP}"/><circle cy="26" r="8" fill="{DEEP}"/>', ''), ' rotate(14)')
    body.append(hands_svg(k, nose_extra=sign_svg, above=excl_svg))
    # sparkles that belong to Hands' moments
    hs = ''
    hs += burst(c, SX, SY, t_slam + .02, 6, 98, 12)
    hs += burst(c, *NOSE_EDGE, t_catch, 4, 34, 9)
    hs += heart(c, HOME[0] + 50, HOME[1] - 230, t_slam + .25, 12, CORAL, 14) + heart(c, HOME[0] + 10, HOME[1] - 210, t_slam + .45, 9, DEEP, -12)
    hs += heart(c, EDGE[0] - 60, EDGE[1] - 210, t_clap + .2, 10, CORAL, -10)
    hs += heart(c, TITLE[0] + 150, 300, t_jump + 1.2, 14, CORAL, 16) + heart(c, TITLE[0] + 190, 340, t_jump + 1.4, 10, DEEP, 10)
    clap_pt = (EDGE[0] - 2, EDGE[1] - (488 - 250) * S0)
    for i in range(3):
        hs += sparkle(c, clap_pt[0] + (-26 if i % 2 else 22), clap_pt[1] - 30 - i * 6, t_clap + .1 + i * .18, 9 + (i % 2) * 3, YELLOW if i % 2 == 0 else CORAL)
    body.append(hs)

    # ------------------------------------------------ Hands' bubbles
    def hb(x, y, w, h, s, tx, tip, t_in, t_out, size=20):
        cls = c.anim(pop(c, t_in, t_out, s0=.4), origin=f'{tip[0]}px {tip[1]}px')
        return G(cls, f'<path d="{bubble_d(x, y, w, h, h / 2, tx, tip[0], tip[1])}" fill="{CORAL}"/>' +
                 text(x + w / 2, y + h / 2 + size * .36, s, size, WHITE, 700, 'middle'))
    body.append(hb(150, 448, 248, 50, 'No approval, no seal.', 196, (168, 530), t_slam + .55, tNotes + .3))
    body.append(hb(900, 562, 136, 48, 'go ahead', 1000, (1046, 628), tAside + 2.0, tAside + 2.75))

    css = '\n'.join(c.css)
    style = (f'text{{font-family:{FONT}}}'
             f'@media (prefers-reduced-motion:reduce){{*{{animation-delay:-{fmt(t_slam + .9, 2)}s!important;animation-play-state:paused!important}}}}')
    return svg_doc(W, H, 'Lookma demo: talk to your Mac, Hands the seal does the clicking',
                   style + '\n' + css, ''.join(body))


def svg_doc(w, h, title, css, body):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img">'
            f'<title>{esc(title)}</title><style>{css}</style>{body}</svg>\n')


def main():
    for dark, th, suffix in ((False, LIGHT, ''), (True, DARK, '-dark')):
        with open(os.path.join(OUT, f'demo{suffix}.svg'), 'w') as f:
            f.write(build_demo(th, dark))
    try:
        import features
    except ImportError:
        return
    features.build_all(OUT)


if __name__ == '__main__':
    import sys
    sys.path.insert(0, HERE)
    main()

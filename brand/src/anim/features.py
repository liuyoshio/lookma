"""Three small looping feature illustrations (600x340): see, say, aside."""
import math
import os

from animgen import (BLUSH, CORAL, DEEP, DARK, FONT, INE, INK, INOUT, LIGHT, OUTE, SINE, SPRING, WHITE, YELLOW,
                     Clock, G, Mover, O, T, at, blink_frames, bubble_d, burst, card_svg, ease_in, ease_out, ease_spring,
                     eq_bars, esc, fmt, hands_svg, heart, mic, notes_icon, pop, rect, spark_d, sparkle, stamp_svg,
                     svg_doc, text, window)

W, H = 600, 340
CURSOR = 'M0 0V27L7 20.6L11.6 31.2L16.4 29.2L11.8 18.8H21.2Z'


def nose_scene(ax, ay, s, f=1, r=0):
    """Scene position of the ring on Hands' nose for anchor (ax, ay), scale s, flip f, lean r degrees."""
    x, y = 352, 64.6
    a = math.radians(r)
    xr = 256 + (x - 256) * math.cos(a) - (y - 488) * math.sin(a)
    yr = 488 + (x - 256) * math.sin(a) + (y - 488) * math.cos(a)
    xf = 256 + f * (xr - 256)
    return ax - 256 * s + xf * s, ay - 488 * s + yr * s


def backdrop(c, th, dark, extra_blobs=''):
    tw = ''
    for i, (x, y, r) in enumerate([(40, 300, 5), (560, 30, 6), (300, 20, 4), (470, 300, 4)]):
        d = 2.4 + i * .6
        cls = c.loop([(0, T(0, 0, 0, .2, opacity=.2)), (d * .5, T(0, 0, 45, 1, opacity=.9), SINE), (d, T(0, 0, 90, .2, opacity=.2))], d)
        tw += at(x, y, G(cls, f'<path d="{spark_d(r)}" fill="{th["twinkle"]}"/>'))
    return (f'<defs><linearGradient id="fbg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{th["bg1"]}"/>'
            f'<stop offset="1" stop-color="{th["bg2"]}"/></linearGradient><clipPath id="frame"><rect width="{W}" height="{H}" rx="28"/></clipPath></defs>'
            f'<g clip-path="url(#frame)"><rect width="{W}" height="{H}" fill="url(#fbg)"/>'
            f'<circle cx="80" cy="60" r="150" fill="{th["blob1"]}" opacity=".55"/>'
            f'<circle cx="560" cy="320" r="170" fill="{th["blob2"]}" opacity=".55"/>' + extra_blobs + tw)


def ring_el(c, mover, base_r, base_w, spin_frames):
    pos = c.anim(mover.frames())
    stroke = c.anim(mover.extra_frames(lambda k, op: {'stroke-width': fmt((base_w - (base_w - 8.5) * min(max((k - 1) / .5, 0), 1)) / k, 3)}))
    spin = c.anim(spin_frames)
    return G(pos, G(spin, G(stroke, f'<circle r="{fmt(base_r)}" fill="none" stroke="{CORAL}"/>') +
                    f'<circle cx="{fmt(-base_r * .66)}" cy="{fmt(-base_r * .66)}" r="{fmt(base_r * .14)}" fill="{WHITE}" opacity=".9"/>'))


def cursor_el(c, mover, clicks):
    cfr = [(0, {'transform': 'scale(1)'})]
    for tc in clicks:
        cfr += [(tc, {'transform': 'scale(1)'}), (tc + .07, {'transform': 'scale(.78)'}), (tc + .22, {'transform': 'scale(1)'})]
    return G(c.anim(mover.frames()), G(c.anim(cfr),
             f'<path d="{CURSOR}" fill="{CORAL}" opacity=".22" transform="translate(-2 -2) scale(1.2)"/>'
             f'<path d="{CURSOR}" fill="{WHITE}" fill-opacity=".92" stroke="{DEEP}" stroke-width="2.2" stroke-linejoin="round"/>'))


def std_hands_joints(c, dur, blinks, happy=(), tail_dur=1.4, bob=True):
    k = {}
    if bob:
        k['bob'] = c.loop([(0, T(0, 0)), (1.2, T(0, -9, 0, 1, 1.012), SINE), (2.4, T(0, 0), SINE)], 2.4)
    k['tail'] = c.loop([(0, T(0, 0, -8)), (tail_dur / 2, T(0, 0, 8), SINE), (tail_dur, T(0, 0, -8), SINE)], tail_dur)
    k['blink'] = c.anim(blink_frames(blinks))
    hfr, efr = [(0, O(0))], [(0, O(1))]
    for a, b in happy:
        hfr += [(a, O(0)), (a + .03, O(1)), (b, O(1)), (b + .03, O(0))]
        efr += [(a, O(1)), (a + .03, O(0)), (b, O(0)), (b + .03, O(1))]
    k['happy'] = c.anim(hfr)
    k['eyes_on'] = c.anim(efr)
    return k


# ---------------------------------------------------------------- see
def build_see(th, dark):
    c = Clock(6.0, 's')
    body = [backdrop(c, th, dark)]
    wx, wy, ww, wh = 26, 34, 420, 272
    btn = '#6FA6FF' if not dark else '#4F86E0'
    BX, BY = 372, 119
    # window + search field + button
    t_click = 2.3
    press = c.anim([(t_click, T(0, 0, 0, 1), OUTE), (t_click + .08, T(0, 0, 0, .9, .86), SPRING), (t_click + .35, T(0, 0, 0, 1))],
                   origin=f'{BX}px {BY}px')
    win = (window(th, wx, wy, ww, wh, 'Maps', barh=40) +
           rect(48, 96, 262, 46, 23, th['field']) +
           f'<circle cx="72" cy="117" r="7" fill="none" stroke="{th["sub"]}" stroke-width="2.6"/><path d="M77 122L82 127" stroke="{th["sub"]}" stroke-width="2.6" stroke-linecap="round"/>' +
           text(90, 125, 'sushi near Ferry Building', 16, th['text'], 500) +
           G(press, rect(BX - 52, 96, 104, 46, 23, btn) + text(BX, 125, 'Search', 18, WHITE, 700, 'middle')))
    rows = ''
    for i, (w1, w2) in enumerate([(150, 90), (120, 70), (170, 100)]):
        ry = 166 + i * 44
        t0 = t_click + .2 + i * .1
        cls = c.anim([(0, T(-18, 0, opacity=0)), (t0, T(-18, 0, opacity=0)), (t0 + .01, T(-18, 0, opacity=0), SPRING), (t0 + .4, T(0, 0, opacity=1)),
                      (5.0, T(0, 0, opacity=1), INE), (5.3, T(0, 6, opacity=0))])
        rows += G(cls, rect(48, ry, 376, 36, 12, th['field']) +
                  f'<circle cx="68" cy="{ry + 18}" r="11" fill="{WHITE}"/><text x="68" y="{ry + 24}" font-size="14" text-anchor="middle">🍣</text>' +
                  rect(88, ry + 9, w1, 8, 4, th['sub'], ' opacity=".55"') + rect(88, ry + 22, w2, 6, 3, th['sub'], ' opacity=".3"'))
    body.append(win + rows)
    # Hands peeks in from the right, flipped to face the window, nose pointing at Search
    S, AX, AY, LEAN = .55, 548, 362, 10
    hp = Mover(700, AY, k=S, ox=256, oy=488)
    hp.hold(.1)
    hp.move(.1, .7, x=AX, ease=ease_spring)
    hp.hold(5.3)
    hp.move(5.3, 5.75, x=700, ease=ease_in)
    k = std_hands_joints(c, 6, [.95, 3.3, 4.9], happy=[(2.45, 3.1), (4.5, 5.0)])
    k['pos'] = c.anim(hp.frames())
    k['flip'] = c.anim([(0, {'transform': 'scale(-1,1)'})])
    t_flick = 1.1
    k['sq'] = c.anim([(0, T(0, 0, LEAN)), (t_flick - .12, T(0, 0, LEAN), OUTE), (t_flick, T(0, 0, LEAN - 4, 1.08, .92)),
                      (t_flick + .1, T(0, 0, LEAN + 6, .93, 1.08), SPRING), (t_flick + .45, T(0, 0, LEAN)),
                      (4.45, T(0, 0, LEAN), OUTE), (4.5, T(0, 0, LEAN, 1.1, .9)), (4.62, T(0, 0, LEAN, .95, 1.05), SINE), (4.8, T(0, 0, LEAN))],
                     origin='256px 488px')
    k['nose'] = c.anim([(0, T(0, 0, 0, opacity=1)), (.62, T(0, 0, 0), OUTE), (.75, T(0, -14, -10), SINE), (.95, T(0, 0, 6), SINE), (1.1, T(0, 0, 0)),
                        (t_flick + .08, T(0, -8, 0, opacity=1)), (t_flick + .1, T(0, 0, 0, opacity=0)), (4.49, T(0, 0, 0, opacity=0)),
                        (4.5, T(0, -22, -14, opacity=1), SPRING), (4.85, T(0, 0, 0))])
    nose0 = nose_scene(AX, AY, S, -1, LEAN)
    rp = Mover(*nose0, k=1, op=0)
    rp.set(t_flick + .09, op=1)
    rp.move(t_flick + .1, t_flick + .7, x=BX, y=BY, k=1.95, h=70)
    rp.settle(t_flick + .7, .4, .12)
    rp.hold(t_click)
    rp.settle(t_click, .35, .16)
    rp.hold(3.9)
    rp.move(3.9, 4.5, x=nose0[0], y=nose0[1], k=1, h=80)
    rp.set(4.5, op=0)
    base_r, base_w = 40 * S, 21 * S
    spin = [(t_flick + .1, T(0, 0, 0), OUTE), (t_flick + .7, T(0, 0, -720)), (3.9, T(0, 0, -720), INOUT), (4.5, T(0, 0, -1080)),
            (4.55, T(0, 0, 0))]
    ring = ring_el(c, rp, base_r, base_w, spin)
    # ghost cursor
    cp = Mover(200, 330, op=0)
    cp.move(1.2, 1.4, op=1)
    cp.move(1.4, 2.0, x=384, y=128, ease=ease_spring)
    cp.hold(3.9)
    cp.move(3.9, 4.3, x=330, y=250, op=0, ease=ease_out)
    cursor = cursor_el(c, cp, [t_click])
    # label tag
    tag = c.anim(pop(c, t_flick + .75, 3.7, s0=.3), origin=f'{BX}px 88px')
    tag_svg = G(tag, f'<path d="{bubble_d(BX - 66, 44, 132, 36, 18, BX, BX, 90)}" fill="{CORAL}"/>' +
                text(BX, 68, 'Click Search', 17, WHITE, 700, 'middle'))
    click_ring = c.anim([(t_click, T(0, 0, 0, .3, opacity=0)), (t_click + .01, T(0, 0, 0, .4, opacity=.8), OUTE), (t_click + .5, T(0, 0, 0, 1.5, opacity=0))])
    fx = (burst(c, BX, BY, t_flick + .7, 4, 52, 10) + at(384, 128, G(click_ring, f'<circle r="22" fill="none" stroke="{CORAL}" stroke-width="3"/>')) +
          heart(c, AX - 40, AY - 250, 2.6, 11, CORAL, -12, 60) + burst(c, *nose0, 4.5, 3, 30, 8))
    body.append(hands_svg(k) + fx + ring + tag_svg + cursor)
    body.append('</g>')
    return svg_doc(W, H, 'Lookma shows each step: a coral ring and a ghost cursor', style(c, 2.6), ''.join(body))


# ---------------------------------------------------------------- say
def build_say(th, dark):
    c = Clock(7.0, 'y')
    body = [backdrop(c, th, dark)]
    cx0, cy0, cw, ch = 22, 98, 396, 214
    t_ok, t_yes, t_slam, t_out = .8, 2.4, 3.35, 6.45
    card = c.anim([(0, T(0, 0, 0, .5, opacity=0)), (.12, T(0, 0, 0, .5, opacity=0)), (.13, T(0, 0, 0, .5, opacity=1), SPRING),
                   (.6, T(0, 0, 0, 1)), (1.3, T(0, 0)), (1.36, T(-7, 0)), (1.44, T(7, 0)), (1.52, T(-5, 0)), (1.6, T(4, 0)), (1.68, T(0, 0)),
                   (t_out, T(0, 0, 0, 1, opacity=1), INE), (t_out + .3, T(0, 0, 0, .7, opacity=0))],
                  origin=f'{cx0 + cw / 2}px {cy0 + ch / 2}px')
    shake = c.anim([(t_slam, T(0, 0)), (t_slam + .05, T(-6, 4)), (t_slam + .1, T(5, -3)), (t_slam + .15, T(-3, 2)), (t_slam + .22, T(1, 0)),
                    (t_slam + .3, T(0, 0))])
    say_c = c.anim([(0, O(1)), (t_slam, O(1)), (t_slam + .12, O(0))])
    ok_c = c.anim([(0, O(0)), (t_slam + .1, O(0)), (t_slam + .25, O(1))])
    mic_c = c.anim([f for i in range(3) for f in ((t_yes + i * .3, T(0, 0, 0, 1, opacity=0)), (t_yes + i * .3 + .01, T(0, 0, 0, 1, opacity=.8), OUTE),
                                                  (t_yes + i * .3 + .5, T(0, 0, 0, 1.6, opacity=0)))], origin=f'{cx0 + 50}px {cy0 + 172}px')
    stamp = c.anim([(0, T(0, 0, -38, 2.6, opacity=0)), (t_slam - .24, T(0, 0, -38, 2.6, opacity=0), INE),
                    (t_slam, T(0, 0, -12, .66, opacity=1), OUTE), (t_slam + .1, T(0, 0, -9, .84), SINE), (t_slam + .24, T(0, 0, -10, .78))])
    lines_burst = ''
    for i in range(10):
        a = i * 36 + 8
        cls = c.anim([(0, T(0, 0, a, .4, opacity=0)), (t_slam, T(0, 0, a, .4, opacity=0)), (t_slam + .01, T(0, 0, a, .4, opacity=1), OUTE),
                      (t_slam + .4, T(0, 0, a, 1.0, opacity=0))])
        lines_burst += G(cls, f'<path d="M80 0H100" stroke="{CORAL if i % 2 else YELLOW}" stroke-width="6" stroke-linecap="round"/>')
    SX, SY = cx0 + cw - 54, cy0 + ch - 40
    body.append(G(card, G(shake, compact_card(th, cx0, cy0, cw, ch, say_c, ok_c, mic_c) +
                          at(SX, SY, lines_burst + G(stamp, stamp_svg())))))
    # the lone "ok" that doesn't count
    okx, oky = 446, 108
    okb = c.anim([(0, T(0, 0, 0, .4, opacity=0)), (t_ok, T(0, 0, 0, .4, opacity=0)), (t_ok + .01, T(0, 0, 0, .4, opacity=1), SPRING),
                  (t_ok + .4, T(0, 0, 0, 1)), (1.3, T(0, 0, 0, 1)), (1.38, T(0, 0, -8, 1)), (1.46, T(0, 0, 8, 1)), (1.54, T(0, 0, -5, 1)),
                  (1.62, T(0, 0, 0, 1)), (1.95, T(0, 0, 0, 1), INE), (2.25, T(0, 26, 12, .8, opacity=0))],
                 origin=f'{okx + 46}px {oky + 74}px')
    strike = c.anim([(0, {'transform': 'scale(0,1)'}), (1.4, {'transform': 'scale(0,1)'}, OUTE), (1.6, {'transform': 'scale(1,1)'})],
                    origin=f'{okx + 18}px 0px')
    body.append(G(okb, f'<path d="{bubble_d(okx, oky, 92, 54, 27, okx + 66, okx + 86, oky + 74)}" fill="{th["ububble"]}"/>' +
                  text(okx + 46, oky + 36, 'ok', 26, th['sub'], 700, 'middle') +
                  G(strike, f'<path d="M{okx + 18} {oky + 30}H{okx + 74}" stroke="{DEEP}" stroke-width="5" stroke-linecap="round"/>')))
    note = c.anim(pop(c, 1.6, t_out, s0=.4), origin='520px 260px')
    body.append(G(note, f'<g transform="rotate(4 520 262)">' + rect(450, 214, 142, 92, 12, th['shadow'], f' opacity="{th["shadow_op"]}" transform="translate(0 6)"') +
                  rect(450, 214, 142, 92, 12, YELLOW) + rect(498, 206, 46, 16, 3, WHITE, ' opacity=".7"') +
                  text(466, 252, 'a lone “ok”', 18, INK, 700) + text(466, 278, 'doesn’t count', 18, INK, 700) + '</g>'))
    # Yes, I approve.
    ux, uy, uw, uh = 318, 20, 272, 60
    yb = c.anim(pop(c, t_yes, t_out - .1, s0=.4), origin=f'{ux + uw - 40}px {uy + uh + 20}px')
    body.append(G(yb, f'<path d="{bubble_d(ux, uy, uw, uh, 24, ux + uw - 60, ux + uw - 34, uy + uh + 20)}" fill="{th["ububble"]}"/>' +
                  mic(ux + 30, uy + 32, CORAL, .95) + text(ux + 52, uy + 39, 'Yes, I approve.', 24, th['utext'], 700) +
                  eq_bars(c, ux + 222, uy + 30, t_yes + .1, t_yes + .9, CORAL, n=3, hmax=16)))
    body.append(burst(c, SX, SY, t_slam + .02, 6, 84, 11) + heart(c, SX + 62, SY - 52, t_slam + .3, 11, CORAL, 14, 56) +
                heart(c, SX + 88, SY - 30, t_slam + .5, 8, DEEP, 18, 46))
    body.append('</g>')
    return svg_doc(W, H, 'Risky steps wait for a spoken “yes, I approve”', style(c, t_slam + .8), ''.join(body))


def compact_card(th, x, y, w, h, say_cls, ok_cls, mic_cls):
    s = (rect(x - 2, y + 10, w + 4, h, 24, th['shadow'], f' opacity="{th["shadow_op"] * 1.3}"') + rect(x, y, w, h, 22, th['win']) +
         rect(x + 22, y, w - 44, 6, 3, CORAL))
    s += f'<circle cx="{x + 34}" cy="{y + 34}" r="8" fill="none" stroke="{CORAL}" stroke-width="4"/>' + text(x + 50, y + 40, 'Lookma needs your OK', 15, CORAL, 700)
    s += notes_icon(x + 48, y + 88, 44)
    s += text(x + 82, y + 86, 'Allow controlling Notes?', 23, th['text'], 700)
    s += text(x + 82, y + 110, 'It wants to write a note.', 16, th['sub'], 500)
    s += f'<path d="M{x + 22} {y + 134}H{x + w - 22}" stroke="{th["winline"]}" stroke-width="1.5"/>'
    s += G(mic_cls, f'<circle cx="{x + 50}" cy="{y + 172}" r="20" fill="none" stroke="{CORAL}" stroke-width="3"/>')
    s += rect(x + 30, y + 152, 40, 40, 20, th['hl']) + mic(x + 50, y + 174, CORAL, .9)
    s += G(say_cls, text(x + 82, y + 179, 'Say “yes, I approve”', 18, th['text'], 700))
    s += G(ok_cls, text(x + 82, y + 179, 'Approved ✓', 18, DEEP, 800), ' opacity="0"')
    return s


# ---------------------------------------------------------------- aside
def build_aside(th, dark):
    c = Clock(6.0, 'a')
    body = [backdrop(c, th, dark)]
    wx, wy, ww, wh = 22, 24, 330, 178
    lines = [('Weekend plans', 20, 700, 104, 140), ('ferry ride at 10, then lunch', 17, 400, 136, 205), ('bring a warm jacket', 17, 400, 164, 152)]
    times = [(.35, .55), (1.05, 1.0), (2.25, .7)]
    content = ''
    caret_fr = [(0, T(0, 0, opacity=1))]
    for (s, size, wt, y, wd), (t0, d) in zip(lines, times):
        cv = c.anim([(0, {'transform': 'scale(1,1)'}), (t0, {'transform': 'scale(1,1)'}, f'steps({len(s)},end)'), (t0 + d, {'transform': 'scale(0,1)'}),
                     (5.55, {'transform': 'scale(0,1)'}), (5.56, {'transform': 'scale(1,1)'})], origin=f'{48 + wd + 6}px 0px')
        content += text(48, y, s, size, th['text'], wt) + G(cv, rect(44, y - size, wd + 10, size + 8, 0, th['win']))
    # caret rides the end of the line being typed
    car = ''
    for (s, size, wt, y, wd), (t0, d) in zip(lines, times):
        nxt = [tt for tt, _ in times if tt > t0]
        t_hide = nxt[0] if nxt else 5.55
        cls = c.anim([(0, T(0, 0, opacity=0)), (t0, T(0, 0, opacity=0)), (t0 + .01, T(0, 0, opacity=1), f'steps({len(s)},end)'), (t0 + d, T(wd, 0, opacity=1)),
                      (t_hide - .01, T(wd, 0, opacity=1)), (t_hide, T(wd, 0, opacity=0))])
        car += G(cls, rect(49, y - size + 1, 2.5, size + 4, 1, CORAL))
    body.append(window(th, wx, wy, ww, wh, 'Draft', barh=40) + content + car)
    # keyboard with bouncing keys
    kx, ky, kw, kh = 22, 216, 330, 104
    kb = rect(kx, ky + 6, kw, kh, 18, th['shadow'], f' opacity="{th["shadow_op"]}"') + rect(kx, ky, kw, kh, 18, th['key_side'])
    keys = []
    for r_ in range(3):
        y = ky + 10 + r_ * 30
        if r_ < 2:
            n = 9
            kwid = (kw - 20 - (n - 1) * 5) / n
            for i in range(n):
                keys.append((kx + 10 + i * (kwid + 5) + (r_ * 8 if i == 0 else r_ * 8), y, kwid - (r_ * 2 if i == 0 else 0), 25))
        else:
            keys.append((kx + 10, y, 50, 25)); keys.append((kx + 65, y, 190, 25)); keys.append((kx + 260, y, 50, 25))
    presses = {}
    seq = [3, 12, 7, 16, 19, 1, 10, 5, 14, 19, 8, 2, 11, 6, 15, 19, 4, 13, 0, 9]
    t = .4
    for j, idx in enumerate(seq):
        presses.setdefault(idx, []).append(t)
        t += .2 if j % 5 != 4 else .32
    for i, (x, y, w, h) in enumerate(keys):
        fr = [(0, T(0, 0, 0, 1, 1)), ]
        lit = [(0, O(0))]
        for tp in presses.get(i, []):
            fr += [(tp, T(0, 0, 0, 1, 1), OUTE), (tp + .05, T(0, 3, 0, 1.04, .82), SPRING), (tp + .25, T(0, 0, 0, 1, 1))]
            lit += [(tp, O(0)), (tp + .03, O(1)), (tp + .3, O(0))]
        cls = c.anim(fr, origin=f'{fmt(x + w / 2)}px {y + h}px')
        lcls = c.anim(lit)
        kb += G(cls, rect(x, y, w, h, 7, th['key'], f' stroke="{th["winline"]}" stroke-width="1"') + G(lcls, rect(x, y, w, h, 7, BLUSH), ' opacity="0"'))
    body.append(kb)
    # Hands, sitting politely at the right edge, facing you
    S, AX, AY = .52, 524, 340
    k = std_hands_joints(c, 6, [1.0, 3.7, 4.0], happy=[(2.7, 3.5)], tail_dur=.9)
    k['pos'] = c.anim([(0, {'transform': f'translate({fmt(AX - 256 * S)}px,{fmt(AY - 488 * S)}px) scale({S})'})])
    k['flip'] = c.anim([(0, {'transform': 'scale(-1,1)'})])
    k['head'] = c.anim([(0, T(0, 0, 0)), (2.5, T(0, 0, 0), SINE), (2.7, T(0, 0, 9), SINE), (2.9, T(0, 0, -3), SINE), (3.1, T(0, 0, 6), SINE),
                        (3.4, T(0, 0, 0))])
    k['nose'] = c.anim([(0, T(0, 0, 0)), (2.6, T(0, 0, 0), SINE), (2.8, T(0, -10, -8), SINE), (3.0, T(0, 0, 6), SINE), (3.2, T(0, 0, -3), SINE), (3.4, T(0, 0, 0))])
    body.append(hands_svg(k))
    tab = c.anim([(0, T(0, 0)), (4.6, T(0, 0), SINE), (4.75, T(-8, 0), SPRING), (5.1, T(0, 0))])
    body.append(G(tab, rect(430, 44, 200, 48, 18, th['shadow'], f' opacity="{th["shadow_op"]}" transform="translate(0 5)"') +
                  rect(430, 44, 200, 48, 18, YELLOW) +
                  f'<rect x="450" y="58" width="5" height="20" rx="2" fill="{INK}"/><rect x="460" y="58" width="5" height="20" rx="2" fill="{INK}"/>' +
                  text(476, 75, 'I’ll wait 🦭', 20, INK, 700)))
    gb = c.anim(pop(c, 2.55, 4.3, s0=.4), origin='452px 200px')
    body.append(G(gb, f'<path d="{bubble_d(366, 136, 112, 46, 23, 448, 466, 202)}" fill="{CORAL}"/>' + text(422, 166, 'go ahead', 18, WHITE, 700, 'middle')))
    body.append(heart(c, 404, 128, 3.0, 10, CORAL, -12, 50))
    body.append('</g>')
    return svg_doc(W, H, 'While you type, Lookma politely steps aside', style(c, 2.9), ''.join(body))


def style(c, freeze):
    return (f'text{{font-family:{FONT}}}'
            f'@media (prefers-reduced-motion:reduce){{*{{animation-delay:-{fmt(freeze)}s!important;animation-play-state:paused!important}}}}\n'
            + '\n'.join(c.css))


def build_all(out):
    for dark, th, suffix in ((False, LIGHT, ''), (True, DARK, '-dark')):
        for name, fn in (('feature-see', build_see), ('feature-say', build_say), ('feature-aside', build_aside)):
            with open(os.path.join(out, f'{name}{suffix}.svg'), 'w') as f:
                f.write(fn(th, dark))

// ?backdrop=1: a neutral fake desktop under the overlay, so development screenshots
// show the marks on the things they point at. Drawn from desk.js, the same geometry
// the mock core sends in `focus`. It follows the snapshots a little: an app the agent
// touches opens and comes forward, and while the user is busy their Notes window is
// in front. Development only; the product overlay never loads this.

import { SCREEN, MENU_H, DOCK, DOCK_ICONS, WINDOWS, SLACK, CHROME, FINDER, NOTES, CONTENT } from './desk.js'

const style = document.createElement('style')
style.textContent = `
#desk { position: fixed; left: 0; top: 0; width: ${SCREEN.w}px; height: ${SCREEN.h}px; overflow: hidden; z-index: 0;
  background: radial-gradient(60% 70% at 20% 25%, #5d6b85, transparent 65%), radial-gradient(55% 60% at 85% 80%, #7a6a73, transparent 65%), linear-gradient(160deg, #3b4352, #2a2f3a);
  font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif; color: #1d1d1f }
#desk .menubar { position: absolute; left: 0; right: 0; top: 0; height: ${MENU_H}px; display: flex; align-items: center; gap: 18px; padding: 0 16px;
  background: rgba(30, 32, 40, .45); color: #fff; font-size: 13px; z-index: 50 }
#desk .menubar b { font-weight: 700 } #desk .menubar .clock { margin-left: auto }
#desk .dock { position: absolute; left: ${DOCK.x}px; top: ${DOCK.y}px; width: ${DOCK.w}px; height: ${DOCK.h}px; border-radius: 20px;
  background: rgba(255, 255, 255, .2); border: .5px solid rgba(255, 255, 255, .3); z-index: 50 }
#desk .icon { position: absolute; border-radius: 12px; display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 20px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, .25) }
#desk .icon span { position: absolute; top: calc(100% + 1px); font-size: 9px; font-weight: 500; color: rgba(255, 255, 255, .8) }
#desk .icon.run::after { content: ""; position: absolute; bottom: -7px; width: 4px; height: 4px; border-radius: 50%; background: rgba(255, 255, 255, .85) }
#desk .win { position: absolute; border-radius: 11px; overflow: hidden; background: #fff; box-shadow: 0 0 0 .5px rgba(0, 0, 0, .3), 0 24px 60px -12px rgba(0, 0, 0, .5) }
#desk .win[hidden] { display: none }
#desk .title { height: 28px; display: flex; align-items: center; justify-content: center; position: relative; font-size: 12px; font-weight: 600; color: #555; background: #ececef }
#desk .title::before { content: ""; position: absolute; left: 12px; top: 9px; width: 10px; height: 10px; border-radius: 50%; background: #ff5f57; box-shadow: 16px 0 #febc2e, 32px 0 #28c840 }
#desk .part { position: absolute }
#desk .slack .title { background: #3a1c3c; color: #e9dcea }
#desk .s-side { background: #4a234d; color: rgba(255, 255, 255, .75); padding: 12px 18px; font-size: 13px }
#desk .s-side h4 { margin: 0 0 8px; color: #fff; font-size: 16px }
#desk .s-row { display: flex; align-items: center; padding: 0 10px; border-radius: 6px; color: rgba(255, 255, 255, .75); font-size: 14px }
#desk .s-row.unread { color: #fff; font-weight: 700 } #desk .s-row.on { background: rgba(255, 255, 255, .9); color: #3a1c3c; font-weight: 700 }
#desk .s-row i { margin-left: auto; font-style: normal; background: #cd2553; color: #fff; border-radius: 9px; padding: 0 6px; font-size: 11px }
#desk .s-lbl { position: absolute; font-size: 12px; color: rgba(255, 255, 255, .55) }
#desk .s-head { display: flex; align-items: center; padding: 0 20px; font-weight: 800; font-size: 16px; border-bottom: 1px solid #eee }
#desk .s-msg { display: grid; grid-template-columns: 36px 1fr; gap: 10px; padding: 8px 10px }
#desk .s-msg .av { width: 36px; height: 36px; border-radius: 8px; background: #8a7fd0 }
#desk .s-msg:nth-child(2) .av { background: #5aa58c } #desk .s-msg:nth-child(3) .av { background: #d08a5a }
#desk .s-msg b { font-size: 14px } #desk .s-msg time { margin-left: 6px; font-size: 12px; color: #777 } #desk .s-msg p { margin: 2px 0 0; font-size: 14px }
#desk .s-compose { border: 1px solid #c7c7c7; border-radius: 9px; display: flex; align-items: center; padding: 0 14px; color: #888; font-size: 14px }
#desk .c-strip { height: 40px; background: #dfe3e8 } #desk .chrome .title { display: none }
#desk .c-tab { position: absolute; display: flex; align-items: center; padding: 0 12px; font-size: 12px; background: #fff; border-radius: 9px 9px 0 0 }
#desk .c-omni { border-radius: 15px; background: #eef1f4; display: flex; align-items: center; padding: 0 14px; font-size: 13px; color: #333 }
#desk .c-page { background: linear-gradient(180deg, #e7f0fb, #fff 60%) }
#desk .wx { padding: 22px 26px; border-radius: 14px; background: rgba(255, 255, 255, .7); box-shadow: 0 1px 0 rgba(0, 0, 0, .05) }
#desk .wx h3 { margin: 0; font-size: 15px; font-weight: 500; color: #5f6368 } #desk .wx .deg { font-size: 72px; font-weight: 300; line-height: 1.1 }
#desk .wx p { margin: 4px 0 0; color: #3c4043; font-size: 15px }
#desk .f-side { background: #ececef; padding-top: 10px } #desk .f-row { display: flex; align-items: center; padding: 0 10px; border-radius: 6px; font-size: 13px }
#desk .f-row.on { background: rgba(0, 0, 0, .08) } #desk .f-cap { position: absolute; font-size: 11px; font-weight: 600; color: rgba(0, 0, 0, .4) }
#desk .f-list { padding: 4px 10px } #desk .f-list div { height: 24px; display: flex; align-items: center; padding: 0 8px; font-size: 13px; border-radius: 5px }
#desk .f-list div:nth-child(odd) { background: #f4f4f6 }
#desk .n-body { background: #fffdf2; padding: 16px 22px; white-space: pre-wrap; font-size: 14px; line-height: 1.6; color: #333 }
`
document.head.append(style)

const desk = document.createElement('div')
desk.id = 'desk'
document.body.prepend(desk)

const el = (cls, rect, parent, html = '') => {
  const d = document.createElement('div')
  d.className = cls
  if (rect) Object.assign(d.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` })
  d.innerHTML = html
  parent.append(d)
  return d
}
const rel = (r, w) => ({ x: r.x - w.x, y: r.y - w.y, w: r.w, h: r.h })
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

el('menubar', null, desk, '<b>Finder</b><span>File</span><span>Edit</span><span>View</span><span>Go</span><span>Window</span><span class="clock">Thu 10:24 AM</span>')
el('dock', null, desk)
const COLORS = { Finder: '#3d8ef0', Slack: '#4a154b', Chrome: '#2f9e57', Notes: '#e8b400', Terminal: '#2b2b2b' }
const icons = {}
for (const [app, r] of Object.entries(DOCK_ICONS)) {
  icons[app] = el('icon', r, desk, `${app[0]}<span>${app}</span>`)
  icons[app].style.background = COLORS[app]
  icons[app].style.zIndex = 51
}

const wins = {}
function win(app, cls) {
  const W = WINDOWS[app]
  const w = el(`win ${cls}`, W, desk, `<div class="title">${esc(W.title)}</div>`)
  w.hidden = true
  wins[app] = w
  return w
}

// Slack-like
{
  const w = win('Slack', 'slack'), W = WINDOWS.Slack
  el('part s-side', rel(SLACK.sidebar, W), w, '<h4>Acme Studio</h4>')
  el('s-lbl', { x: 28, y: 28 + 46, w: 120, h: 16 }, w, 'Channels')
  el('s-lbl', { x: 28, y: 28 + 172, w: 160, h: 16 }, w, 'Direct messages')
  for (const [name, r] of Object.entries(SLACK.channels)) {
    const unread = name === '# design'
    const row = el(`part s-row${unread ? ' unread' : ''}`, rel(r, W), w, `${esc(name)}${unread ? '<i>3</i>' : ''}`)
    if (unread) row.dataset.ch = 'design'
  }
  el('part s-head', rel(SLACK.header, W), w, '# design')
  const msgs = el('part', rel(SLACK.messages, W), w)
  msgs.style.display = 'flex'; msgs.style.flexDirection = 'column'; msgs.style.justifyContent = 'flex-end'
  for (const [who, time, text] of CONTENT.slackMessages) el('s-msg', null, msgs, `<i class="av"></i><div><b>${esc(who)}</b><time>${time}</time><p>${esc(text)}</p></div>`)
  el('part s-compose', rel(SLACK.compose, W), w, 'Message #design')
}
// Chrome-like
{
  const w = win('Chrome', 'chrome'), W = WINDOWS.Chrome
  el('part c-strip', { x: 0, y: 0, w: W.w, h: 40 }, w)
  el('part c-tab', { x: 80, y: 8, w: 210, h: 32 }, w, 'Start Page').style.background = 'transparent'
  el('part c-tab', rel(CHROME.newTab, W), w, 'Weather — Forecast')
  el('part c-omni', rel(CHROME.omnibox, W), w, 'weather.example.com/forecast/tomorrow')
  el('part c-page', rel(CHROME.page, W), w)
  const f = CONTENT.forecast
  el('part wx', rel(CHROME.forecast, W), w, `<h3>${f.place}</h3><div class="deg">${f.high}</div><p>${f.sky} · low ${f.low} · rain ${f.rain}</p>`)
}
// Finder-like
{
  const w = win('Finder', 'finder'), W = WINDOWS.Finder
  el('part f-side', rel(FINDER.sidebar, W), w)
  el('f-cap', { x: 16, y: 28 + 14, w: 100, h: 14 }, w, 'Favorites')
  for (const [name, r] of Object.entries(FINDER.places)) el(`part f-row${name === 'Downloads' ? ' on' : ''}`, rel(r, W), w, esc(name))
  const list = el('part f-list', rel(FINDER.list, W), w)
  for (const f of CONTENT.finderFiles) el('', null, list, esc(f))
}
// Notes: the user's own window
{
  const w = win('Notes', 'notes'), W = WINDOWS.Notes
  el('part n-body', rel(NOTES.body, W), w, esc(CONTENT.notes))
}

// Follow the snapshots: what the agent touches opens and comes forward.
let z = 10
const raise = app => { const w = wins[app]; if (!w) return; w.hidden = false; w.style.zIndex = ++z; icons[app]?.classList.add('run') }
const APP_OF = { 'Google Chrome': 'Chrome' }
let lastStep = null
addEventListener('lookma:state', e => {
  const s = e.detail
  if (s.attention?.busy) raise('Notes')
  const f = s.focus
  if (!f || f.id === lastStep || f.phase === 'moving' || f.phase === 'waiting') return
  lastStep = f.id
  const app = APP_OF[f.app] || f.app
  if (f.background) { wins[app] && (wins[app].hidden = false); return }
  raise(app)
})
// Something to look at from the start.
raise('Finder')

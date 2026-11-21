// The fake desktop used in development: one geometry, shared by the scripted
// mock core (which sends these rects in `focus`) and the ?backdrop=1 drawing,
// so the marks land on the things they point at. Screen points, 1440 x 900.

export const SCREEN = { w: 1440, h: 900 }
export const MENU_H = 25

export const center = r => [Math.round(r.x + r.w / 2), Math.round(r.y + r.h / 2)]

// Dock: bottom centre, like macOS.
export const DOCK_APPS = ['Finder', 'Slack', 'Chrome', 'Notes', 'Terminal']
const ICON = 52, GAP = 10, PAD = 8
const dockW = DOCK_APPS.length * ICON + (DOCK_APPS.length - 1) * GAP + 2 * PAD
export const DOCK = { x: (SCREEN.w - dockW) / 2, y: SCREEN.h - 6 - (ICON + 2 * PAD), w: dockW, h: ICON + 2 * PAD }
export const DOCK_ICONS = Object.fromEntries(DOCK_APPS.map((app, i) => [app, {
  x: DOCK.x + PAD + i * (ICON + GAP), y: DOCK.y + PAD, w: ICON, h: ICON,
}]))

// Windows, back to front in their initial order.
export const WINDOWS = {
  Finder: { x: 250, y: 120, w: 760, h: 470, title: 'Downloads' },
  Chrome: { x: 300, y: 56, w: 980, h: 660, title: 'New Tab' },
  Slack: { x: 140, y: 64, w: 920, h: 620, title: 'Slack' },
  Notes: { x: 760, y: 170, w: 600, h: 440, title: 'Notes' },
}

const TITLE_H = 28
const at = (win, x, y, w, h) => {
  const W = WINDOWS[win]
  return { x: W.x + x, y: W.y + y, w, h }
}

// Slack-like chat app.
const S = WINDOWS.Slack
const SIDE = 230
export const SLACK = {
  sidebar: at('Slack', 0, TITLE_H, SIDE, S.h - TITLE_H),
  channels: {
    '# general': at('Slack', 10, TITLE_H + 66, SIDE - 20, 28),
    '# design': at('Slack', 10, TITLE_H + 96, SIDE - 20, 28),
    '# random': at('Slack', 10, TITLE_H + 126, SIDE - 20, 28),
    'Sam Lee': at('Slack', 10, TITLE_H + 192, SIDE - 20, 28),
  },
  header: at('Slack', SIDE, TITLE_H, S.w - SIDE, 48),
  messages: at('Slack', SIDE + 12, TITLE_H + 56, S.w - SIDE - 24, S.h - TITLE_H - 56 - 78),
  compose: at('Slack', SIDE + 20, S.h - 66, S.w - SIDE - 40, 46),
}

// Chrome-like browser.
const C = WINDOWS.Chrome
export const CHROME = {
  tabs: at('Chrome', 80, 6, 440, 32),
  newTab: at('Chrome', 300, 8, 210, 30),
  omnibox: at('Chrome', 90, 44, C.w - 140, 30),
  page: at('Chrome', 0, 80, C.w, C.h - 80),
  forecast: at('Chrome', 70, 130, 560, 250),
}

// Finder-like file browser.
const F = WINDOWS.Finder
export const FINDER = {
  sidebar: at('Finder', 0, TITLE_H, 170, F.h - TITLE_H),
  places: {
    Recents: at('Finder', 8, TITLE_H + 34, 154, 24),
    Applications: at('Finder', 8, TITLE_H + 60, 154, 24),
    Desktop: at('Finder', 8, TITLE_H + 86, 154, 24),
    Documents: at('Finder', 8, TITLE_H + 112, 154, 24),
    Downloads: at('Finder', 8, TITLE_H + 138, 154, 24),
  },
  list: at('Finder', 170, TITLE_H + 24, F.w - 170, F.h - TITLE_H - 24),
  file: i => at('Finder', 180, TITLE_H + 28 + 24 * i, F.w - 190, 24), // row i of CONTENT.finderFiles
}

export const NOTES = { body: at('Notes', 0, TITLE_H, WINDOWS.Notes.w, WINDOWS.Notes.h - TITLE_H) }

// Contents, all made up.
export const CONTENT = {
  slackMessages: [
    ['Riley Park', '10:02', 'The design review moved to Friday at 2 pm.'],
    ['Sam Lee', '10:15', 'New icon set is in the shared folder. Feedback welcome.'],
    ['Jordan Kim', '10:41', 'Could someone look at the onboarding copy before Friday?'],
  ],
  finderFiles: ['q3-report.pdf', 'q3-slides.pdf', 'photo-0412.jpg', 'setup.dmg', 'notes.txt'],
  notes: 'Groceries\n- oat milk\n- coffee beans\n- lemons\n\nIdeas for the weekend\n- visit the farmers market\n- fix the shelf',
  forecast: { place: 'Tomorrow', high: '72°', low: '58°', rain: '10%', sky: 'Mostly sunny' },
}

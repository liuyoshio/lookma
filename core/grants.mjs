// Which apps the hands may control: { "Slack": true, "Mail": false } in ~/.lookma/apps.json.
// Read on every lookup so a hand edit takes effect at once.
import fs from 'node:fs'
import path from 'node:path'

export function createGrants(file) {
  function read() {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return {}
    }
  }
  return {
    get: app => read()[app],
    set(app, allow) {
      const all = read()
      all[app] = allow
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(all, null, 2) + '\n')
    },
  }
}

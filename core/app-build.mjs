// The app bundle (config.app, built by app/build.sh) and the one rule for when it needs a build:
// it is missing, or something it is built from is newer than its binary. `lookma start` builds
// it then; `lookma doctor` only says so.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// What app/build.sh builds from. Folders count too: removing a file changes only its folder's time.
function sources(root) {
  const tree = dir => [dir, ...fs.readdirSync(dir, { recursive: true }).map(f => path.join(dir, f))]
  const app = path.join(root, 'app')
  return [path.join(app, 'Info.plist'), ...tree(path.join(app, 'Sources')), ...tree(path.join(app, 'Resources'))]
}

export function isStale(config) {
  const binary = path.join(config.app, 'Contents', 'MacOS', path.basename(config.app, '.app'))
  const built = fs.statSync(binary, { throwIfNoEntry: false })?.mtimeMs ?? 0
  return sources(config.root).some(f => fs.statSync(f).mtimeMs > built)
}

// build.sh prints its own progress and errors.
export function build(config) {
  const r = spawnSync(path.join(config.root, 'app', 'build.sh'), { stdio: 'inherit' })
  if (r.status !== 0) throw new Error('building the app failed; run lookma doctor')
}

// The one vocabulary of step titles: the line the capsule shows for a step of the agent's that is
// not on screen. An adapter maps each of its agent's tool events to a kind and a detail; the words
// are written here only, so every agent's steps read alike. The hands show themselves and are
// never steps.
//   read    a file's path, or a web page's URL       "Read notes.txt", "Read example.com"
//   list    a folder's path, or nothing               "List src", "List files"
//   search  what is searched for in files, or nothing  "Search for ramen", "Search files"
//   web     a web search's query, or nothing          "Search the web for ramen"
//   run     a command line                            "npm test"
//   write, edit, delete   one path or several         "Edit a.md + 1 more"
//   tool    another tool, as "server · tool"          "docs · search"
import path from 'node:path'
import { clip } from '../util.mjs'

const base = p => path.basename(p)

// A URL reads as its host; a path as its file name.
const source = s => (URL.canParse(s) && /^https?:/.test(s) ? new URL(s).host : base(s))

function files(verb, detail) {
  const [first, ...rest] = [detail].flat()
  if (!first) return `${verb} files`
  return `${verb} ${base(first)}${rest.length ? ` + ${rest.length} more` : ''}`
}

const KINDS = {
  read: d => `Read ${source(d)}`,
  list: d => (d && d !== '.' ? `List ${base(d)}` : 'List files'),
  search: d => (d ? `Search for ${clip(d, 40)}` : 'Search files'),
  web: d => (d ? `Search the web for ${clip(d, 40)}` : 'Search the web'),
  run: d => clip(d),
  write: d => files('Write', d),
  edit: d => files('Edit', d),
  delete: d => files('Delete', d),
  tool: d => clip(d),
}

/** The title of a step: kind is one of the keys above, detail what it says. */
export function title(kind, detail) {
  return KINDS[kind](detail)
}

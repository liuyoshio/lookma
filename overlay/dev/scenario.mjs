// The scripted scenario the mock core replays. English, made-up content, no private
// data. Each `mark` is a moment worth a screenshot; shoot.mjs captures them.
//
//   1. open Slack from the Dock and read new messages
//   2. a Chrome tab (tomorrow's forecast)
//   3. a background task (yellow)
//   4. the user is busy: background work, then waiting for the front, then resume
//   5. an approval card, answered by click
//   6. a correction mid-turn

import { DOCK_ICONS, WINDOWS, SLACK, CHROME, FINDER, center } from './desk.js'

export async function scenario(s) {
  await s.sleep(1.2)
  s.mark('idle')
  await s.sleep(1.5)

  // 1. Slack via the Dock
  s.heard('Open Slack and check my new messages')
  await s.sleep(0.6)
  s.mark('heard')
  await s.sleep(1)
  await s.turn('Open Slack from the Dock and tell me what is new in my channels', async () => {
    await s.sleep(0.4)
    s.mark('relay')
    await s.sleep(1.4)
    await s.step({ action: 'open', app: 'Slack', label: 'Open Slack from the Dock', rect: DOCK_ICONS.Slack, point: center(DOCK_ICONS.Slack), mark: 'dock' })
    await s.step({ action: 'see', app: 'Slack', label: 'Look at Slack', rect: WINDOWS.Slack })
    await s.step({ action: 'click', app: 'Slack', label: 'Open #design (3 unread)', rect: SLACK.channels['# design'], point: center(SLACK.channels['# design']), mark: 'channel' })
    await s.step({ action: 'see', app: 'Slack', label: 'Read 3 new messages', rect: SLACK.messages, mark: 'read', hold: 1.6 })
    s.say('#design: review moved to Friday 2 pm · Sam shared new icons · Jordan wants eyes on the onboarding copy',
      'Three new messages in design. The review moved to Friday at 2, Sam shared new icons, and Jordan wants someone to look at the onboarding copy.')
  })
  await s.sleep(0.8)
  s.mark('result')
  await s.sleep(4.5)

  // 2. A Chrome tab
  s.heard("What's the weather tomorrow?")
  await s.sleep(1.3)
  await s.turn("Open tomorrow's forecast in Chrome and tell me the high and the chance of rain", async () => {
    await s.sleep(1.4)
    await s.step({ action: 'open', app: 'Google Chrome', label: 'Open the forecast in a new tab', rect: CHROME.newTab, mark: 'tab' })
    await s.step({ action: 'see', app: 'Google Chrome', label: 'Read the forecast', rect: CHROME.forecast, hold: 1.2 })
    s.say('Tomorrow: 72°, mostly sunny, 10% chance of rain', 'Tomorrow will be mostly sunny with a high of 72 and a ten percent chance of rain.')
  })
  await s.sleep(4)

  // 3. A background task
  s.heard("In the background, summarize this week's meeting notes")
  await s.sleep(1.3)
  await s.turn("In the background: summarize this week's meeting notes in ~/Documents/Notes", async () => {
    await s.sleep(1.2)
    s.status('Start a background task')
    s.task('t1', 'Summarize meeting notes', 'Reading 6 files')
    await s.sleep(1)
    s.say("Started. I'll tell you when it's done.", "Started. I'll tell you when it's done.")
  })
  await s.sleep(1)
  s.mark('task')
  await s.sleep(3)

  // 4. The user is busy
  s.heard("Reply in #design that I'll review the copy on Friday")
  s.attention(true)
  await s.sleep(1.3)
  await s.turn('In Slack #design, reply: "I\'ll review the onboarding copy on Friday."', async () => {
    await s.sleep(1.2)
    await s.step({ action: 'see', app: 'Slack', label: 'Read #design', rect: WINDOWS.Slack, background: true, mark: 'background', hold: 1.4 })
    s.task('t1', 'Summarize meeting notes', 'Writing the summary')
    await s.step({ action: 'click', app: 'Slack', label: 'Click the message box', rect: SLACK.compose, point: center(SLACK.compose), needsFront: true, mark: 'compose' })
    await s.step({ action: 'type', app: 'Slack', label: 'Type the reply', rect: SLACK.compose, hold: 1.2 })
    await s.step({ action: 'key', app: 'Slack', label: 'Send with Return', rect: SLACK.compose })
    s.say('Replied in #design.', 'Done, I replied in design.')
  })
  await s.sleep(3)

  // 5. An approval card
  s.heard('Move the two Q3 files from Downloads into Documents/Archive')
  await s.sleep(1.3)
  await s.turn('Move q3-report.pdf and q3-slides.pdf from ~/Downloads to ~/Documents/Archive', async () => {
    await s.sleep(1.2)
    s.status('List ~/Downloads')
    await s.sleep(1.5)
    s.status('Move 2 files to ~/Documents/Archive')
    const ok = await s.card({
      title: 'Run a command: move 2 files to ~/Documents/Archive',
      detail: 'mv ~/Downloads/q3-report.pdf ~/Downloads/q3-slides.pdf ~/Documents/Archive/',
      options: [{ n: 1, text: 'Yes' }, { n: 2, text: "Yes, and don't ask again for mv commands" }, { n: 3, text: 'No, and tell Claude what to do differently' }],
      source: 'executor',
      mark: 'card',
    })
    if (!ok) { s.status('Declined'); s.say('Okay, I left both files in Downloads.', 'Okay, I left both files in Downloads.'); return }
    s.status('Moved 2 files')
    await s.sleep(1)
    s.say('Moved both files to ~/Documents/Archive.', 'Moved both files to Documents, Archive.')
  })
  await s.sleep(1.2)
  s.taskDone('t1', 'Saved to ~/Documents/Notes/summary.md: 3 decisions, 5 action items',
    'The meeting notes summary is ready: three decisions and five action items, saved in your Notes folder.')
  await s.sleep(0.8)
  s.mark('report')
  await s.sleep(3)

  // 6. A correction
  s.heard('Open the Downloads folder in Finder')
  await s.sleep(1.3)
  await s.turn('Open the Downloads folder in Finder', async () => {
    await s.sleep(1.2)
    await s.step({ action: 'open', app: 'Finder', label: 'Open Finder from the Dock', rect: DOCK_ICONS.Finder, point: center(DOCK_ICONS.Finder) })
    s.heard('Sorry, I meant Documents, not Downloads')
    await s.sleep(1.2)
    s.steer('Correction from the user: open the Documents folder, not Downloads')
    await s.sleep(0.9)
    s.mark('correction')
    await s.sleep(1)
    await s.step({ action: 'click', app: 'Finder', label: 'Open Documents', rect: FINDER.places.Documents, point: center(FINDER.places.Documents), mark: 'documents' })
    s.say('Documents is open.', 'Documents is open.')
  })
  await s.sleep(2.5)
  s.mark('end')
}

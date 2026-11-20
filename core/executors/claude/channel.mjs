#!/usr/bin/env node
// The MCP server Claude Code spawns, as a development channel: mcp-bridge.mjs (say and the hands)
// plus what only Claude needs, prompts and permission requests through the channel:
//   core  → channel: { type: 'prompt', text }, { type: 'permissionAnswer', request_id, behavior }
//   channel → core:  { type: 'permission', request_id, tool_name, description, input_preview }
// Started from the .mcp.json that session.mjs writes, which also sets LOOKMA_CORE_URL.
import { z } from 'zod'
import { serve } from '../mcp-bridge.mjs'
import { SAY, HANDS } from '../../tools.mjs'

// Claude Code sends this when a tool-approval dialog opens; the terminal dialog stays open too.
const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({ request_id: z.string(), tool_name: z.string(), description: z.string(), input_preview: z.string() }),
})

await serve({
  // alwaysLoad: Claude Code lists these tools to the model from the start instead of deferring them
  // behind its tool search, so say and the hands are never a lookup away.
  tools: [SAY, ...HANDS].map(t => ({ ...t, _meta: { 'anthropic/alwaysLoad': true } })),
  capabilities: { experimental: { 'claude/channel': {}, 'claude/channel/permission': {} } },
  instructions:
    'The user talks to you by voice through Lookma and watches the screen; they cannot see this terminal. ' +
    'Their words arrive as <channel source="lookma"> messages: that is the user speaking. ' +
    'Speak to them only with the say tool. Work on screen only with the see, click, type, key, scroll and open tools.',
  setup({ mcp, send }) {
    mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => send({ type: 'permission', ...params }))
  },
  async onCore(msg, { mcp }) {
    if (msg.type === 'prompt') {
      await mcp.notification({ method: 'notifications/claude/channel', params: { content: msg.text, meta: {} } })
    } else if (msg.type === 'permissionAnswer') {
      await mcp.notification({ method: 'notifications/claude/channel/permission', params: { request_id: msg.request_id, behavior: msg.behavior } })
    }
  },
})

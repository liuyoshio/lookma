#!/usr/bin/env node
// The MCP server Codex spawns from the thread config (session.mjs): say and the hands, nothing more.
import { serve } from '../mcp-bridge.mjs'

await serve()

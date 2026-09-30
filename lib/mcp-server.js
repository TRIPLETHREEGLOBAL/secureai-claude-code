#!/usr/bin/env node
'use strict';
/**
 * SecureAI MCP server (stdio, newline-delimited JSON-RPC 2.0).
 *
 * Tools: secureai_status, secureai_protect, secureai_off.
 * Usage: node mcp-server.js --platform cursor|codex|claude|grok
 *
 * Status text comes from Core only. The server never claims protection itself.
 */

const readline = require('readline');
const { withCore, describe, explainError, CUSTOMER_PLATFORMS } = require('./secureai-core.js');

function argPlatform() {
  const i = process.argv.indexOf('--platform');
  const p = i >= 0 ? process.argv[i + 1] : process.env.SECUREAI_PLATFORM;
  return CUSTOMER_PLATFORMS.includes(p) ? p : null;
}

const PLATFORM = argPlatform();
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

// Mirrors secureai_protocol::SessionState. Anything else is reported as null.
const CORE_STATES = ['off', 'requested', 'connecting', 'protected', 'reconnecting', 'failed', 'unsupported'];

// Structured results repeat the text result; they never add a claim Core did not make.
const ROUTE_STATUS_SCHEMA = {
  type: 'object',
  properties: {
    platform: { type: 'string', enum: CUSTOMER_PLATFORMS },
    state: {
      type: ['string', 'null'],
      enum: [...CORE_STATES, null],
      description: 'Core’s session state for this platform; null when Core has no status for it.',
    },
    desired: { type: 'boolean', description: 'The user asked Core to protect this platform.' },
    traffic_observed: {
      type: 'boolean',
      description: 'Core carried traffic for this platform in its current session.',
    },
    message: { type: 'string', description: 'The same text as the text content.' },
  },
  required: ['platform', 'state', 'desired', 'traffic_observed', 'message'],
  additionalProperties: false,
};

const OFF_SCHEMA = {
  type: 'object',
  properties: {
    platform: { type: 'string', enum: CUSTOMER_PLATFORMS },
    desired: { type: 'boolean', const: false },
    message: { type: 'string', description: 'The same text as the text content.' },
  },
  required: ['platform', 'desired', 'message'],
  additionalProperties: false,
};

const TOOLS = [
  {
    name: 'secureai_status',
    description: 'Show SecureAI Core’s route status and coverage limits for this platform.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: ROUTE_STATUS_SCHEMA,
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  },
  {
    name: 'secureai_protect',
    description: 'Request Core protection for supported local traffic (the user’s choice is remembered).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: ROUTE_STATUS_SCHEMA,
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
  },
  {
    name: 'secureai_off',
    description: 'Turn Core protection off for supported local traffic on this platform.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: OFF_SCHEMA,
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function text(t, isError = false) {
  return { content: [{ type: 'text', text: t }], isError };
}

function structured(data) {
  return { ...text(data.message), structuredContent: data };
}

function routeStatus(st) {
  return {
    platform: PLATFORM,
    state: st && CORE_STATES.includes(st.state) ? st.state : null,
    desired: Boolean(st && st.desired),
    traffic_observed: Boolean(st && st.traffic_seen_at),
    message: describe(st, PLATFORM),
  };
}

async function currentStatus() {
  return withCore(PLATFORM, async (c) => {
    const s = await c.status();
    return routeStatus((s.statuses || []).find((x) => x.platform === PLATFORM));
  });
}

async function callTool(name) {
  if (!PLATFORM) return text('SecureAI adapter is misconfigured (missing --platform).', true);
  try {
    switch (name) {
      case 'secureai_status':
        return structured(await currentStatus());
      case 'secureai_protect': {
        await withCore(PLATFORM, (c) => c.protect(PLATFORM));
        return structured(await currentStatus());
      }
      case 'secureai_off': {
        await withCore(PLATFORM, (c) => c.off(PLATFORM));
        return structured({
          platform: PLATFORM,
          desired: false,
          message: 'Core protection is off for supported local traffic on this platform.',
        });
      }
      default:
        return text(`Unknown tool: ${name}`, true);
    }
  } catch (e) {
    return text(explainError(e), true);
  }
}

async function handle(req) {
  const { id, method, params } = req;
  const isNotification = id === undefined || id === null;
  switch (method) {
    case 'initialize': {
      const asked = params && params.protocolVersion;
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'secureai', version: '0.1.0' },
        },
      });
      return;
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;
    case 'ping':
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    case 'tools/list':
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;
    case 'tools/call': {
      const result = await callTool(params && params.name);
      send({ jsonrpc: '2.0', id, result });
      return;
    }
    default:
      if (!isNotification) {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
  }
}

if (require.main === module) {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let req;
    try {
      req = JSON.parse(line);
    } catch (_) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    handle(req).catch(() => {
      if (req && req.id !== undefined) {
        send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: 'Internal error' } });
      }
    });
  });
}

module.exports = { handle, TOOLS };

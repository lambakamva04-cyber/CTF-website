#!/usr/bin/env node
// Pushes assistants/hope.ts to Vapi, so the prompt in git is the prompt that
// answers the phone.
//
//   VAPI_PRIVATE_KEY=... node scripts/sync-assistant.mjs --dry-run
//   VAPI_PRIVATE_KEY=... node scripts/sync-assistant.mjs
//   VAPI_PRIVATE_KEY=... node scripts/sync-assistant.mjs --id asst_xxxx
//
// Without --id it looks Hope up by name and updates her, or creates her if she
// is not there. With --id it updates that assistant regardless of name, which
// is what you want once the id is recorded against an organization in D1.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const API = 'https://api.vapi.ai';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const idFlag = args.indexOf('--id');
const explicitId = idFlag !== -1 ? args[idFlag + 1] : null;

const key = process.env.VAPI_PRIVATE_KEY?.trim();
if (!key && !dryRun) {
  console.error(
    'VAPI_PRIVATE_KEY is not set.\n' +
      'Find it in the Vapi dashboard under Settings → API Keys → Private Key.\n' +
      'Run with --dry-run to see the payload without it.',
  );
  process.exit(1);
}

// The config is TypeScript, so it is compiled on the fly rather than duplicated
// as JSON. esbuild already ships with vite, so this adds no dependency.
function loadConfig() {
  const out = execFileSync(
    path.join(ROOT, 'node_modules', '.bin', 'esbuild'),
    [
      path.join(ROOT, 'assistants', 'hope.ts'),
      '--bundle',
      '--format=esm',
      '--platform=node',
      '--log-level=warning',
    ],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  const encoded = Buffer.from(out).toString('base64');
  return import(`data:text/javascript;base64,${encoded}`);
}

const { HOPE, HOPE_VERSION } = await loadConfig();

// Vapi rejects unknown keys on some endpoints, and `name` is matched on, so the
// payload is assembled explicitly rather than spread wholesale.
const payload = {
  name: HOPE.name,
  firstMessage: HOPE.firstMessage,
  voicemailMessage: HOPE.voicemailMessage,
  endCallMessage: HOPE.endCallMessage,
  model: HOPE.model,
  voice: HOPE.voice,
  transcriber: HOPE.transcriber,
  silenceTimeoutSeconds: HOPE.silenceTimeoutSeconds,
  maxDurationSeconds: HOPE.maxDurationSeconds,
  startSpeakingPlan: HOPE.startSpeakingPlan,
  stopSpeakingPlan: HOPE.stopSpeakingPlan,
  analysisPlan: HOPE.analysisPlan,
  serverMessages: HOPE.serverMessages,
};

if (!process.env.VAPI_VOICE_ID) {
  console.warn(
    'Warning: VAPI_VOICE_ID is not set, so the fallback voice id is being used.\n' +
      '  Pick a voice in the Vapi dashboard and set VAPI_VOICE_ID to its id.\n',
  );
}

if (dryRun) {
  console.log(`Hope, version ${HOPE_VERSION} — payload that would be sent:\n`);
  console.log(JSON.stringify(payload, null, 2));
  console.log(
    `\nSystem prompt is ${payload.model.messages[0].content.length} characters.`,
  );
  process.exit(0);
}

async function vapi(pathname, init = {}) {
  const response = await fetch(`${API}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    // Vapi's validation errors name the offending field, which is the useful
    // part — printed rather than swallowed behind a generic failure.
    throw new Error(`${init.method ?? 'GET'} ${pathname} → ${response.status}\n${text}`);
  }
  return text ? JSON.parse(text) : null;
}

let assistantId = explicitId;

if (!assistantId) {
  const existing = await vapi('/assistant');
  const match = Array.isArray(existing)
    ? existing.find((assistant) => assistant.name === HOPE.name)
    : null;
  assistantId = match?.id ?? null;
}

if (assistantId) {
  await vapi(`/assistant/${assistantId}`, { method: 'PATCH', body: JSON.stringify(payload) });
  console.log(`Updated ${HOPE.name} (${assistantId}) to version ${HOPE_VERSION}.`);
} else {
  const created = await vapi('/assistant', { method: 'POST', body: JSON.stringify(payload) });
  assistantId = created.id;
  console.log(`Created ${HOPE.name} (${assistantId}) at version ${HOPE_VERSION}.`);
}

console.log(
  '\nTo point the dashboard at it, set the assistant id on the organization:\n' +
    `  npx wrangler d1 execute ctf-app --remote --command "UPDATE organizations SET vapi_assistant_id = '${assistantId}' WHERE slug = 'YOUR-ORG-SLUG'"\n`,
);
console.log(
  'Then set the assistant\'s Server URL to https://app.cutthroughfaster.com/api/vapi/webhook\n' +
    'with the same secret you set as VAPI_WEBHOOK_SECRET.',
);

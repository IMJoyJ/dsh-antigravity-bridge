#!/usr/bin/env node
// ag.mjs — zero-new-dependency Node ESM CLI wrapping the compiled
// dsh-antigravity-bridge library (../lib/index.mjs).
//
// Run from the repo root so the library's bare imports
// (@bufbuild/protobuf, protobufjs, ws, @deepseek-ai/cordis,
// @deepseek-ai/schemastery) resolve via the repo's node_modules:
//   node cli/ag.mjs <command> [options]
//
// Stdout is UTF-8 human-readable by default; --json switches to machine output.

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  HubClient,
  listConversations,
  getConversationTree,
  readCascadeTranscript,
  loadTranscriptFile,
  getDefaultAppDataDir,
  buildSettlementNotice,
  isWaitingSpeech,
} from '../lib/index.mjs';

const DEFAULT_MODEL = process.env.AG_DEFAULT_MODEL || 'gemini-3.8-flash-high';
const INLINE_BUDGET = 4000;
const SETTLE_STABLE_MS = 4000;
const STEP_END_WAIT_MS = 10_000;
// Same refusal pattern as AntigravityService.buildSettlementNotice in src/index.ts.
const REFUSAL_RE = /无法协助|违反|safety policy|cannot assist|unable to assist|policy violation|作为AI|抱歉，我无法|I cannot fulfill|against our safety guidelines/i;
const EXIT = { DONE: 0, ERROR: 1, APPROVAL: 2 };

// ---------------------------------------------------------------------------
// tiny arg parser
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  const flags = new Set();
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        opts[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        // value-taking options; everything else is boolean
        if (VALUE_OPTS.has(a.slice(2))) {
          opts[a.slice(2)] = argv[i + 1];
          i++;
        } else {
          flags.add(a.slice(2));
        }
      } else {
        flags.add(a.slice(2));
      }
    } else if (a.startsWith('-') && a.length === 2) {
      const short = SHORTS[a[1]];
      if (short) flags.add(short);
      else throw new Error(`Unknown flag: ${a}`);
    } else {
      positional.push(a);
    }
    i++;
  }
  return { positional, opts, flags };
}

const VALUE_OPTS = new Set([
  'task', 'model', 'project', 'conversation', 'timeout', 'content',
  'mode', 'scope', 'parent', 'depth', 'name', 'folder',
]);
const SHORTS = { h: 'help' };

function usage() {
  return `ag.mjs — Antigravity bridge CLI (hub backend, no new dependencies)

Usage:
  node cli/ag.mjs [--json] <command> [options]

Commands:
  delegate --task <text|@file> [--model M] [--project <folder-path|UUID>]
           [--conversation <id>]
      Start a new cascade (or continue --conversation) and exit immediately
      with the cascadeId. Default model: $AG_DEFAULT_MODEL or
      "gemini-3.8-flash-high". --project accepts an absolute folder path
      (bound directly to the workspace via workspaceUris) or a registered
      project UUID. Folder paths are the robust form: hub-side project
      creation is not always persisted, while the folder URI always binds.

  wait <cascadeId> [--timeout <seconds, default 43200>]
      Block until done / error / awaiting-approval / refusal-or-early-death /
      timeout. Prints a settlement card. Exit codes: 0=done,
      2=awaiting-approval, 1=error/timeout/refusal.

  send <cascadeId> --content <text|@file> [--mode step-end|turn-end|interrupt]
       [--wait]
      Inject a steering message. Default mode step-end (waits up to 10s for the
      current tool step to finish, then cancels-if-engaged and sends, mirroring
      the plugin). Delivery is confirmed via transcript.jsonl with one retry.
      --wait blocks like 'wait' after delivery.

  respond <cascadeId> (--confirm|--deny) [--scope S]
      Answer a pending IDE approval dialog via the hub approval RPC.
      Scope default PERMISSION_SCOPE_ONCE; also PERMISSION_SCOPE_CONVERSATION /
      WORKSPACE / PROJECT / GLOBAL (short names accepted).

  models
      List hub models with quotaRemainingFraction/quotaResetTime.

  conversations [--roots] [--parent <id>] [--depth N]
      List stored conversations (default: all incl. subagents; --roots: roots
      only; --parent: direct children of <id>; --depth: max depth filter).

  tree <cascadeId>
      Render the lineage ASCII tree for a conversation (or recent roots when
      the id is unknown).

  project --name <N> --folder <abs-path>
      Create a hub project rooted at <abs-path>, print the projectId.

Global flags:
  --json    machine-readable JSON on stdout
  -h, --help  this text (or per-command help: <command> --help)

Env overrides:
  AG_HUB_ADDRESS / AG_HUB_CSRF_TOKEN  pin the hub connection (else auto-discover
                                      the running Antigravity language_server)
  AG_DEFAULT_MODEL                    default model for delegate/send resume
  AG_APP_DATA_DIR                     override ~/.gemini/antigravity

Run from the plugin repo root:  node cli/ag.mjs --help`;
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function hubCreateConfig() {
  const cfg = {};
  if (process.env.AG_HUB_ADDRESS) cfg.address = process.env.AG_HUB_ADDRESS;
  if (process.env.AG_HUB_CSRF_TOKEN) cfg.csrfToken = process.env.AG_HUB_CSRF_TOKEN;
  return cfg;
}

function appDataDir() {
  return process.env.AG_APP_DATA_DIR || getDefaultAppDataDir();
}

function brainDir() {
  return join(appDataDir(), 'brain');
}

function isHubMissing(err) {
  return err instanceof Error && /hub not found|Ensure the IDE is running/i.test(err.message);
}

function friendlyHubError(err) {
  if (isHubMissing(err)) {
    return 'Antigravity IDE is not running (hub discovery failed: no live language_server hub found). Start the Antigravity IDE and retry, or pin the connection with AG_HUB_ADDRESS + AG_HUB_CSRF_TOKEN.';
  }
  return err instanceof Error ? err.message : String(err);
}

function fail(msg, code = 1) {
  process.stderr.write(`Error: ${msg}\n`);
  process.exitCode = code;
}

async function resolveText(value, what) {
  if (value === undefined) throw new Error(`Missing required ${what}.`);
  if (value.startsWith('@')) {
    const file = value.slice(1);
    try {
      return await readFile(file, 'utf8');
    } catch (err) {
      throw new Error(`Cannot read ${what} file "${file}": ${err instanceof Error ? err.message : err}`);
    }
  }
  return value;
}

function toFolderUri(folderOrPath) {
  const v = folderOrPath.trim();
  if (/^file:\/\//i.test(v)) return v;
  if (/^[A-Za-z]:[\\/]/.test(v)) return 'file:///' + v.replace(/\\/g, '/');
  if (v.startsWith('/')) return 'file://' + v;
  return 'file:///' + v.replace(/\\/g, '/');
}

function fmtElapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Best-effort confirmation that a sent user message materialized in the
// cascade transcript. Mirrors AntigravityService.confirmMessageDelivered:
// probe a run of letters/digits (verbatim in JSONL) with polling + timeout.
async function confirmMessageDelivered(brain, cascadeId, content, timeoutMs = 8000) {
  const probe = (content.match(/[\p{L}\p{N}]{8,}/u)?.[0] ?? '').slice(0, 24);
  if (!probe) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const loaded = await loadTranscriptFile(brain, cascadeId);
    if (loaded && loaded.text.includes(probe)) return true;
    await sleep(500);
  }
  return false;
}

// Resolve the MODEL_* enum for SendUserCascadeMessage. Required whenever the
// hub may construct a fresh executor (idle resume); never throws — falls back
// to a model-less send like the plugin's planModelFor.
async function planModelFor(client, display) {
  try {
    return await client.resolveModelCached(display || DEFAULT_MODEL);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// settlement core (shared by wait / send --wait)
// ---------------------------------------------------------------------------

async function classifyCascade(client, cascadeId) {
  const snap = await readCascadeTranscript(brainDir(), cascadeId, -1);
  if (!snap) return { status: 'running', snap: undefined };
  if (snap.error) {
    return {
      status: 'error',
      snap,
      content: snap.plannerContents.join('\n\n'),
      error: snap.error,
      lastActiveAt: snap.lastActiveAt,
    };
  }
  if (snap.pendingApproval) {
    const isReal = await client.isCascadeAwaitingApproval(cascadeId);
    if (isReal) {
      await sleep(1500);
      const stillReal = await client.isCascadeAwaitingApproval(cascadeId);
      if (stillReal) {
        return {
          status: 'awaiting-approval',
          snap,
          content: snap.plannerContents.join('\n\n'),
          pendingTool: snap.pendingApproval,
          lastActiveAt: snap.lastActiveAt,
        };
      }
    }
    return { status: 'running', snap };
  }
  if (snap.activeBackgroundTasks && snap.activeBackgroundTasks.length > 0) {
    return { status: 'running', snap };
  }
  if (snap.isFinished && snap.plannerContents.length > 0) {
    if (snap.tailKind === 'tool-call' || snap.tailKind === 'tool-result') {
      return { status: 'running', snap }; // stale isFinished; model stalled mid-turn
    }
    const last = snap.plannerContents[snap.plannerContents.length - 1];
    if (isWaitingSpeech(last)) return { status: 'running', snap };
    return {
      status: 'done-candidate',
      snap,
      content: snap.plannerContents.join('\n\n'),
      lastActiveAt: snap.lastActiveAt,
    };
  }
  return { status: 'running', snap };
}

// Block until terminal/attention state. Returns a settlement record.
async function waitForSettlement(client, cascadeId, timeoutMs, startedAt) {
  const deadline = Date.now() + timeoutMs;
  let lastChange = Date.now();
  let lastFingerprint = '';
  let last = { status: 'running', snap: undefined, content: '', lastActiveAt: undefined };
  let interval = 2000;

  while (Date.now() < deadline) {
    const res = await classifyCascade(client, cascadeId);
    const snap = res.snap;
    const fingerprint = snap
      ? `${snap.maxStepIndex}:${snap.lastActiveAt ?? ''}:${(res.content ?? '').length}`
      : 'none';
    if (fingerprint !== lastFingerprint) {
      lastFingerprint = fingerprint;
      lastChange = Date.now();
      interval = 2000;
    } else {
      // idle backoff: quiet transcripts are polled less often
      interval = Date.now() - lastChange > 60_000 ? 5000 : 2000;
    }

    if (res.status === 'done-candidate') {
      if (Date.now() - lastChange >= SETTLE_STABLE_MS) {
        return finishSettlement(cascadeId, startedAt, 'done', res);
      }
      last = { ...res, status: 'running' };
    } else if (res.status === 'running') {
      last = res;
    } else {
      return finishSettlement(cascadeId, startedAt, res.status, res);
    }
    await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
  }

  // deadline: honest snapshot, never a fabricated terminal state
  const snap = await readCascadeTranscript(brainDir(), cascadeId, -1).catch(() => undefined);
  return finishSettlement(cascadeId, startedAt, 'timeout', {
    snap,
    content: snap?.plannerContents.join('\n\n') ?? last.content ?? '',
    lastActiveAt: snap?.lastActiveAt,
    pendingTool: snap?.pendingApproval,
    error: 'wait timeout',
  });
}

function finishSettlement(cascadeId, startedAt, status, res) {
  const content = (res.content ?? '').trim();
  const run = {
    cascadeId,
    status: status === 'refusal' ? 'done' : status,
    startedAt,
    content,
    error: res.error,
    pendingTool: res.pendingTool,
    lastActiveAt: res.lastActiveAt,
  };
  // Refusal / early-death gate. Reuses the plugin's own heuristic via
  // buildSettlementNotice, but splits it for truthful exit codes (documented
  // deviation): an explicit refusal(*) exits 1 as 'refusal', while a merely
  // short/fast reply with no refusal language still settles 'done' (exit 0)
  // with an early-termination warning — e.g. a trivial task answered "OK".
  // (*) same pattern as AntigravityService.buildSettlementNotice.
  if (status === 'done') {
    const notice = buildSettlementNotice(run);
    if (notice.isRefusalOrEarlyDeath) {
      if (REFUSAL_RE.test(content)) {
        return { ...settlementBase(cascadeId, startedAt, content, res), status: 'refusal', run };
      }
      return { ...settlementBase(cascadeId, startedAt, content, res), status: 'done', earlyDeath: true, run };
    }
  }
  return { ...settlementBase(cascadeId, startedAt, content, res), status, run };
}

function settlementBase(cascadeId, startedAt, content, res) {
  return {
    cascadeId,
    elapsedMs: Date.now() - startedAt,
    content,
    pendingTool: res.pendingTool,
    error: res.error,
    lastActiveAt: res.lastActiveAt,
  };
}

async function spillReport(cascadeId, content) {
  const dir = join(tmpdir(), 'ag-bridge-reports', cascadeId);
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `turn-1-${stamp}.md`);
  await writeFile(file, content, 'utf8');
  return file;
}

async function printSettlement(s, json) {
  const elapsed = fmtElapsed(s.elapsedMs);
  let reportPath;
  let body = s.content;
  let truncated = false;
  if (body && body.length > INLINE_BUDGET) {
    reportPath = await spillReport(s.cascadeId, body);
    body = `${body.slice(0, INLINE_BUDGET)}\n…[truncated, ${body.length - INLINE_BUDGET} more chars]`;
    truncated = true;
  }

  if (json) {
    process.stdout.write(`${JSON.stringify({
      cascadeId: s.cascadeId,
      status: s.status,
      elapsedMs: s.elapsedMs,
      lastActiveAt: s.lastActiveAt ?? null,
      pendingTool: s.pendingTool ?? null,
      error: s.error ?? null,
      earlyDeath: s.earlyDeath ?? false,
      content: s.content || null,
      contentTruncated: truncated,
      totalChars: s.content.length,
      reportPath: reportPath ?? null,
    }, null, 2)}\n`);
    return reportPath;
  }

  const lines = [
    '=== Antigravity cascade settlement ===',
    `cascadeId: ${s.cascadeId}`,
    `status: ${s.status}`,
    `elapsed: ${elapsed}`,
  ];
  if (s.lastActiveAt) lines.push(`lastActiveAt: ${s.lastActiveAt}`);
  if (s.status === 'awaiting-approval' && s.pendingTool) {
    const pt = s.pendingTool;
    lines.push(`pendingTool: ${pt.name || 'unknown'} (${pt.action || pt.summary || 'n/a'})`);
    const argsJson = pt.args ? JSON.stringify(pt.args, null, 2) : '{}';
    lines.push(`pendingToolArgs: ${argsJson.length > 1500 ? `${argsJson.slice(0, 1500)}\n…(args truncated)` : argsJson}`);
    lines.push('> Antigravity IDE is waiting for approval — answer with: ag.mjs respond <id> --confirm|--deny');
  }
  if (s.status === 'error' && s.error) lines.push(`error: ${s.error}`);
  if (s.earlyDeath) lines.push(`> Early termination warning: settled fast with only ${s.content.length} chars — verify the task truly completed.`);
  if (s.status === 'timeout') lines.push(`timeout: no terminal state reached (${s.error || 'deadline elapsed'})`);
  if (s.status === 'refusal') lines.push('> Model refusal or abnormal early termination detected.');
  lines.push(`--- report (${s.content.length} chars) ---`);
  lines.push(body || '(no planner output)');
  if (reportPath) {
    lines.push(`Full report (${s.content.length} chars): ${reportPath}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return reportPath;
}

function exitFor(status) {
  if (status === 'done') return EXIT.DONE;
  if (status === 'awaiting-approval') return EXIT.APPROVAL;
  return EXIT.ERROR;
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function cmdDelegate(args, json) {
  if (args.flags.has('help')) {
    const t = 'delegate --task <text|@file> [--model M] [--project <folder-path|UUID>] [--conversation <id>]\nStart or continue a cascade, print the cascadeId, exit immediately (never waits).\nFolder paths bind via workspaceUris; UUIDs must be registered and persisted on the hub.';
    if (json) process.stdout.write(`${JSON.stringify({ help: t })}\n`);
    else process.stdout.write(`${t}\n`);
    return 0;
  }
  const task = await resolveText(args.opts.task, '--task');
  if (!task.trim()) throw new Error('--task must not be empty.');
  const model = args.opts.model || DEFAULT_MODEL;
  const conversationId = args.opts.conversation;

  const client = await HubClient.create(hubCreateConfig());
  const startedAt = Date.now();

  if (conversationId) {
    const planModel = await planModelFor(client, model);
    await client.sendMessage(conversationId, task, { planModel });
    const result = {
      cascadeId: conversationId,
      status: 'running',
      continued: true,
      model,
      elapsedMs: Date.now() - startedAt,
    };
    if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      process.stdout.write(`cascadeId: ${result.cascadeId}\nstatus: running (continued conversation)\nmodel: ${model}\n`);
    }
    return 0;
  }

  const targetInput = args.opts.project || process.cwd();
  const resolvedProj = await client.resolveOrCreateProject(targetInput);
  const resolvedModel = await client.resolveModel(model);
  if (!resolvedModel) {
    throw new Error(`Model "${model}" not found on hub; run 'ag.mjs models' for valid ids.`);
  }
  const cascadeId = randomUUID();
  await client.startCascade({
    cascadeId,
    requestedModel: resolvedModel,
    projectId: resolvedProj.projectId,
    workspaceUri: resolvedProj.workspaceUri,
    sidebarVisible: true,
  });
  await client.sendMessage(cascadeId, task, { planModel: resolvedModel });

  const result = {
    cascadeId,
    status: 'running',
    continued: false,
    model,
    projectId: resolvedProj.projectId,
    workspaceUri: resolvedProj.workspaceUri,
    projectCreated: resolvedProj.created,
    elapsedMs: Date.now() - startedAt,
  };
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    const binding = resolvedProj.projectId
      ? `${resolvedProj.projectName} (${resolvedProj.projectId}${resolvedProj.created ? ', created' : ''})`
      : `${resolvedProj.projectName} (folder-bound via workspaceUris)`;
    process.stdout.write(
      `cascadeId: ${cascadeId}\nstatus: running\nmodel: ${model}\nproject: ${binding}\n`,
    );
  }
  return 0;
}

async function cmdWait(args, json) {
  if (args.flags.has('help')) {
    const t = 'wait <cascadeId> [--timeout <seconds, default 43200>]\nBlock until done/error/awaiting-approval/refusal/timeout; print a settlement card. Exits 0/2/1.';
    if (json) process.stdout.write(`${JSON.stringify({ help: t })}\n`);
    else process.stdout.write(`${t}\n`);
    return 0;
  }
  const cascadeId = args.positional[0];
  if (!cascadeId) throw new Error('Missing <cascadeId>.');
  const timeoutSec = args.opts.timeout === undefined ? 43200 : Number(args.opts.timeout);
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) throw new Error('--timeout must be a positive number of seconds.');

  const client = await HubClient.create(hubCreateConfig());
  const startedAt = Date.now();
  const s = await waitForSettlement(client, cascadeId, timeoutSec * 1000, startedAt);
  await printSettlement(s, json);
  return exitFor(s.status);
}

async function cmdSend(args, json) {
  if (args.flags.has('help')) {
    const t = 'send <cascadeId> --content <text|@file> [--mode step-end|turn-end|interrupt] [--wait]\nInject a steering message (default step-end, delivery-confirmed, one retry). --wait blocks to next terminal state.';
    if (json) process.stdout.write(`${JSON.stringify({ help: t })}\n`);
    else process.stdout.write(`${t}\n`);
    return 0;
  }
  const cascadeId = args.positional[0];
  if (!cascadeId) throw new Error('Missing <cascadeId>.');
  const content = await resolveText(args.opts.content, '--content');
  if (!content.trim()) throw new Error('--content must not be empty.');
  const mode = args.opts.mode || 'step-end';
  if (!['step-end', 'turn-end', 'interrupt'].includes(mode)) {
    throw new Error(`--mode must be step-end|turn-end|interrupt (got "${mode}").`);
  }
  const wait = args.flags.has('wait');

  const client = await HubClient.create(hubCreateConfig());
  const brain = brainDir();

  if (mode === 'turn-end') {
    // Stateless CLI deviation from the plugin: the plugin parks the message in
    // an in-memory queue drained by its per-cascade watcher at turn end. The
    // CLI has no resident watcher, so turn-end blocks until the current turn
    // settles (up to 1h) and then delivers as a fresh message.
    const pre = await waitForSettlement(client, cascadeId, 3_600_000, Date.now());
    if (pre.status !== 'done' && pre.status !== 'awaiting-approval' && pre.status !== 'error' && pre.status !== 'refusal') {
      throw new Error(`turn-end: current turn did not settle within 1h (last status guess: ${pre.status}).`);
    }
  } else if (mode === 'step-end') {
    // Mirror the plugin: wait up to 10s for the running tool step to finish.
    const deadline = Date.now() + STEP_END_WAIT_MS;
    while (Date.now() < deadline) {
      const snap = await readCascadeTranscript(brain, cascadeId);
      if (snap?.pendingApproval || snap?.isFinished || !snap?.engaged) break;
      await sleep(200);
    }
  }

  // Only cancel when genuinely mid-step: cancelling an idle cascade makes the
  // IDE show a spurious "User cancelled agent execution" and the follow-up
  // message vanishes hub-side (plugin v3.11 lesson).
  const snapBeforeSend = await readCascadeTranscript(brain, cascadeId);
  const genuinelyEngaged = !!snapBeforeSend
    && snapBeforeSend.engaged
    && !snapBeforeSend.isFinished
    && !snapBeforeSend.pendingApproval;
  if (genuinelyEngaged && mode !== 'turn-end') {
    try {
      await client.cancelCascade(cascadeId);
    } catch { /* ignore: already idle */ }
    await sleep(250);
  }

  const preSnap = await readCascadeTranscript(brain, cascadeId, -1);

  const planModel = await planModelFor(client);
  await client.sendMessage(cascadeId, content, { planModel });

  let delivered = await confirmMessageDelivered(brain, cascadeId, content);
  if (!delivered) {
    try {
      await client.sendMessage(cascadeId, content, { planModel });
      delivered = await confirmMessageDelivered(brain, cascadeId, content, 10_000);
    } catch { /* fall through to failure report */ }
  }
  if (!delivered) {
    const msg = `DELIVERY FAILED for ${cascadeId}: message not visible in transcript after send + resend. The cascade may need a fresh conversation or IDE-side nudge.`;
    if (json) process.stdout.write(`${JSON.stringify({ cascadeId, delivered: false, error: msg }, null, 2)}\n`);
    else process.stdout.write(`${msg}\n`);
    return 1;
  }

  if (!wait) {
    const msg = `Message injected into ${cascadeId} (${mode}); transcript delivery confirmed.`;
    if (json) {
      process.stdout.write(`${JSON.stringify({
        cascadeId,
        delivered: true,
        mode,
        baselineStepIndex: preSnap?.maxStepIndex ?? -1,
      }, null, 2)}\n`);
    } else process.stdout.write(`${msg}\n`);
    return 0;
  }

  const s = await waitForSettlement(client, cascadeId, 43200 * 1000, Date.now());
  await printSettlement(s, json);
  return exitFor(s.status);
}

const SCOPES = new Set([
  'PERMISSION_SCOPE_ONCE',
  'PERMISSION_SCOPE_CONVERSATION',
  'PERMISSION_SCOPE_WORKSPACE',
  'PERMISSION_SCOPE_PROJECT',
  'PERMISSION_SCOPE_GLOBAL',
]);

async function cmdRespond(args, json) {
  if (args.flags.has('help')) {
    const t = 'respond <cascadeId> (--confirm|--deny) [--scope S]\nAnswer a pending IDE approval via the hub RPC. Scope default PERMISSION_SCOPE_ONCE.';
    if (json) process.stdout.write(`${JSON.stringify({ help: t })}\n`);
    else process.stdout.write(`${t}\n`);
    return 0;
  }
  const cascadeId = args.positional[0];
  if (!cascadeId) throw new Error('Missing <cascadeId>.');
  const confirmFlag = args.flags.has('confirm');
  const denyFlag = args.flags.has('deny');
  if (confirmFlag === denyFlag) throw new Error('Pass exactly one of --confirm or --deny.');
  const confirm = confirmFlag;

  let scope = args.opts.scope || 'PERMISSION_SCOPE_ONCE';
  if (!scope.startsWith('PERMISSION_SCOPE_')) scope = `PERMISSION_SCOPE_${scope}`;
  if (!SCOPES.has(scope)) {
    throw new Error(`--scope must be one of ${[...SCOPES].join(' / ')} (got "${args.opts.scope}").`);
  }

  const client = await HubClient.create(hubCreateConfig());
  // Mirror AntigravityService.hubRespondApproval: read the pending interaction
  // from the live trajectory and answer it via HandleCascadeUserInteraction.
  const traj = await client.getCascadeTrajectory(cascadeId);
  const trajectory = traj?.trajectory ?? {};
  const trajectoryId = trajectory.trajectoryId;
  const steps = trajectory.steps ?? [];
  if (!trajectoryId) throw new Error('GetCascadeTrajectory returned no trajectoryId.');

  let pending;
  for (let i = steps.length - 1; i >= 0; i--) {
    const ri = steps[i]?.requestedInteraction;
    if (ri && Object.keys(ri).length > 0) {
      pending = { stepIndex: i, ri };
      break;
    }
  }
  if (!pending) throw new Error('No pending requestedInteraction in trajectory (nothing to approve).');

  const { stepIndex, ri } = pending;
  let variant;
  let kind;
  if (ri.runCommand) {
    kind = 'run_command';
    const proposed = ri.runCommand.commandLine ?? ri.runCommand.proposedCommandLine ?? '';
    variant = { runCommand: { confirm, proposedCommandLine: proposed, submittedCommandLine: proposed } };
  } else if (ri.readUrlContent) {
    kind = 'read_url_content';
    variant = { readUrlContent: { confirm } };
  } else if (ri.permission) {
    kind = `permission(${ri.permission.resource?.action ?? '?'}:${ri.permission.resource?.target ?? '?'})`;
    variant = { permission: { allow: confirm, scope } };
  } else if (ri.filePermission) {
    kind = `file_permission(${ri.filePermission.absolutePathUri ?? '?'})`;
    variant = { filePermission: { allow: confirm, scope, absolutePathUri: ri.filePermission.absolutePathUri ?? '' } };
  } else if (ri.approvalInteraction) {
    kind = 'approval_interaction';
    variant = { approvalInteraction: { confirm } };
  } else if (ri.mcp) {
    kind = 'mcp';
    variant = { mcp: { confirm } };
  } else if (ri.openBrowserUrl) {
    kind = 'open_browser_url';
    variant = { openBrowserUrl: { confirm } };
  } else {
    throw new Error(`Unsupported interaction variant; keys present: ${Object.keys(ri).join(', ')}`);
  }

  const resp = await client.handleCascadeUserInteraction(cascadeId, {
    trajectoryId,
    stepIndex,
    ...variant,
  });
  const result = { cascadeId, answered: kind, confirm, scope, stepIndex, hubResponse: resp ?? {} };
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    const verb = confirm ? 'approved' : 'rejected';
    process.stdout.write(`Approval ${verb}: ${kind} at step ${stepIndex} (scope ${scope}) in ${cascadeId}.\n`);
  }
  return 0;
}

async function cmdModels(args, json) {
  if (args.flags.has('help')) {
    const t = 'models\nList hub models with quotaRemainingFraction/quotaResetTime.';
    if (json) process.stdout.write(`${JSON.stringify({ help: t })}\n`);
    else process.stdout.write(`${t}\n`);
    return 0;
  }
  const client = await HubClient.create(hubCreateConfig());
  const resp = await client.getAvailableModels();
  const models = resp?.response?.models;
  if (!models) {
    throw new Error(`GetAvailableModels returned an unexpected shape (missing response.models): ${JSON.stringify(resp).slice(0, 300)}`);
  }
  const slim = {};
  for (const [id, m] of Object.entries(models)) {
    const quota = m.quotaInfo ?? {};
    slim[id] = {
      displayName: m.displayName ?? null,
      recommended: m.recommended ?? null,
      maxTokens: m.maxTokens ?? null,
      maxOutputTokens: m.maxOutputTokens ?? null,
      supportsImages: m.supportsImages ?? null,
      quotaRemainingFraction: quota.remainingFraction ?? null,
      quotaResetTime: quota.resetTime ?? null,
    };
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(slim, null, 2)}\n`);
  } else {
    const lines = Object.entries(slim).map(([id, m]) => {
      const q = m.quotaRemainingFraction ?? 'n/a';
      const r = m.quotaResetTime ?? 'n/a';
      const rec = m.recommended ? ' [recommended]' : '';
      return `${id}${rec}  quotaRemaining=${q}  reset=${r}`;
    });
    process.stdout.write(`${lines.join('\n')}\n`);
  }
  return 0;
}

async function cmdConversations(args, json) {
  if (args.flags.has('help')) {
    const t = 'conversations [--roots] [--parent <id>] [--depth N]\nList stored conversations (default: all incl. subagents).';
    if (json) process.stdout.write(`${JSON.stringify({ help: t })}\n`);
    else process.stdout.write(`${t}\n`);
    return 0;
  }
  const opts = {};
  if (args.opts.parent) opts.parentId = args.opts.parent;
  if (args.opts.depth !== undefined) {
    const d = Number(args.opts.depth);
    if (!Number.isFinite(d) || d < 0) throw new Error('--depth must be a non-negative number.');
    opts.maxDepth = d;
  }
  if (args.flags.has('roots')) opts.onlyRoots = true;
  else if (!args.opts.parent) opts.includeSubagents = true;

  const list = await listConversations(opts);
  if (json) {
    process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
  } else if (list.length === 0) {
    process.stdout.write('(no conversations found)\n');
  } else {
    const lines = list.map((c) => {
      const title = c.taskTitle ? ` task="${c.taskTitle}"` : '';
      const snippet = !c.taskTitle && c.firstPromptSnippet
        ? ` "${c.firstPromptSnippet.slice(0, 80)}"`
        : '';
      const sub = c.isSubagent ? ' [sub]' : '';
      return `${c.id}  depth=${c.depth}${sub}  modified=${c.lastModified}${title}${snippet}`;
    });
    process.stdout.write(`${lines.join('\n')}\n`);
  }
  return 0;
}

async function cmdTree(args, json) {
  if (args.flags.has('help')) {
    const t = 'tree <cascadeId>\nRender the lineage ASCII tree for a conversation.';
    if (json) process.stdout.write(`${JSON.stringify({ help: t })}\n`);
    else process.stdout.write(`${t}\n`);
    return 0;
  }
  const cascadeId = args.positional[0];
  if (!cascadeId) throw new Error('Missing <cascadeId>.');
  const { trees, ascii } = await getConversationTree({ conversationId: cascadeId });
  if (json) process.stdout.write(`${JSON.stringify({ ascii, trees }, null, 2)}\n`);
  else process.stdout.write(`${ascii || '(no tree found)'}\n`);
  return 0;
}

async function cmdProject(args, json) {
  if (args.flags.has('help')) {
    const t = 'project --name <N> --folder <abs-path>\nCreate a hub project rooted at <abs-path>, print the projectId.';
    if (json) process.stdout.write(`${JSON.stringify({ help: t })}\n`);
    else process.stdout.write(`${t}\n`);
    return 0;
  }
  const name = args.opts.name;
  const folder = args.opts.folder;
  if (!name) throw new Error('Missing --name.');
  if (!folder) throw new Error('Missing --folder <absolute path>.');
  const client = await HubClient.create(hubCreateConfig());
  const folderUri = toFolderUri(folder);
  const { projectId } = await client.createProject(name, folderUri);
  if (json) process.stdout.write(`${JSON.stringify({ projectId, name, folderUri }, null, 2)}\n`);
  else process.stdout.write(`projectId: ${projectId}\nname: ${name}\nfolder: ${folderUri}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const raw = process.argv.slice(2);
  const { positional, opts, flags } = parseArgs(raw);
  const json = flags.has('json');
  const [cmd, ...rest] = positional;

  if (!cmd || flags.has('help') || flags.has('h')) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const sub = { positional: rest, opts, flags };
  try {
    switch (cmd) {
      case 'delegate': return await cmdDelegate(sub, json);
      case 'wait': return await cmdWait(sub, json);
      case 'send': return await cmdSend(sub, json);
      case 'respond': return await cmdRespond(sub, json);
      case 'models': return await cmdModels(sub, json);
      case 'conversations': return await cmdConversations(sub, json);
      case 'tree': return await cmdTree(sub, json);
      case 'project': return await cmdProject(sub, json);
      default: throw new Error(`Unknown command "${cmd}". Run with --help for usage.`);
    }
  } catch (err) {
    fail(friendlyHubError(err), 1);
    return 1;
  }
}

process.exitCode = await main();

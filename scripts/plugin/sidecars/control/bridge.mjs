import { execFile } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { findTurn, getSummary, getTranscript } from '../../lib/history.mjs';
import { CliError, isConversationId, maxRequestBytes, protocolVersion, sidecarId, socketPath, validateRequest } from '../../lib/protocol.mjs';

const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
if (!dataDir || !process.env.ANTIGRAVITY_LS_ADDRESS) {
  throw new Error('Launch this process through the Antigravity Sidecar.');
}

const endpoint = socketPath(dataDir);
const run = promisify(execFile);
const active = new Set();
const sockets = new Set();

async function agentApi(args, timeout) {
  let stdout;
  let failure;
  try {
    ({ stdout } = await run('agentapi', args, { timeout, maxBuffer: 1024 * 1024, encoding: 'utf8' }));
  } catch (error) {
    failure = error;
    stdout = error.stdout;
  }
  let envelope;
  try { envelope = JSON.parse(stdout); } catch { /* The structured response may be unavailable. */ }
  if (envelope?.error) {
    const message = typeof envelope.error === 'string' ? envelope.error : envelope.error.message ?? 'AgentAPI rejected the request.';
    throw new CliError('AGENTAPI_REJECTED', message, { delivery: 'unknown' });
  }
  if (failure || !envelope?.response) {
    const reason = failure?.killed ? 'AgentAPI timed out.' : 'AgentAPI did not return a usable receipt.';
    throw new CliError('AGENTAPI_UNCONFIRMED', reason, { delivery: 'unknown' });
  }
  return envelope.response;
}

async function waitForReply(id, request, after, deadline) {
  let delivery = 'accepted';
  let input;
  let transcript = null;
  let turn = {};
  while (performance.now() < deadline) {
    const current = getTranscript(id, transcript);
    if (current !== transcript) {
      transcript = current;
      turn = findTurn(transcript?.steps ?? [], { ...request, after });
    }
    if (turn.input) {
      input = turn.input;
      delivery = 'logged';
      const details = { conversation_id: id, delivery, prompt_step: input.step_index };
      if (turn.nextInput) {
        throw new CliError('TURN_INTERRUPTED', 'Another message arrived before this reply could be confirmed. Read the transcript to inspect the turns.', details);
      }
      const summary = getSummary(id);
      const completed = summary?.status === 'CASCADE_RUN_STATUS_IDLE'
        && summary.step_count > transcript.steps.at(-1).step_index;
      if (completed && turn.failure && (!turn.reply || turn.failure.step_index > turn.reply.step_index)) {
        throw new CliError('CONVERSATION_FAILED', String(turn.failure.content), details);
      }
      if (completed && turn.reply) {
        return {
          ...details,
          title: summary.title,
          project_id: summary.project_id,
          reply_step: turn.reply.step_index,
          reply: turn.reply.content,
        };
      }
    }
    await delay(Math.max(0, Math.min(600, deadline - performance.now())));
  }
  throw new CliError('REPLY_TIMEOUT', 'The request was accepted and the reply deadline elapsed. Read the conversation before retrying.', {
    conversation_id: id, delivery, ...(input && { prompt_step: input.step_index }),
  });
}

async function dispatch(request, emit) {
  const { method, prompt, title, model, timeoutSeconds } = request;
  if (method === 'status') return { ready: true, protocol_version: protocolVersion, sidecar_id: sidecarId };

  const deadline = performance.now() + timeoutSeconds * 1000;
  const apiTimeout = Math.min(30000, timeoutSeconds * 1000);
  let { id } = request;
  let after = -1;
  let locked = false;
  let delivery = 'not_sent';
  try {
    if (method === 'send') {
      if (active.has(id)) throw new CliError('BUSY', 'This conversation already has a request pending in the Sidecar.');
      active.add(id);
      locked = true;
      const summary = getSummary(id);
      if (!summary) throw new CliError('NOT_FOUND', 'Desktop conversation not found.');
      const transcript = getTranscript(id);
      after = Math.max(summary.step_count - 1, transcript?.steps.at(-1)?.step_index ?? -1);
      const receipt = await agentApi(['send-message', id, prompt], apiTimeout);
      if (receipt.sendMessage?.recipientId !== id) {
        throw new CliError('AGENTAPI_UNCONFIRMED', 'AgentAPI did not confirm the recipient.', { delivery: 'unknown' });
      }
    } else {
      const flags = [];
      if (title !== undefined) flags.push(`--title=${title}`);
      if (model !== undefined) flags.push(`--model=${model}`);
      const receipt = await agentApi(['new-conversation', ...flags, '--', prompt], apiTimeout);
      id = receipt.newConversation?.conversationId;
      if (!isConversationId(id)) {
        id = undefined;
        throw new CliError('AGENTAPI_UNCONFIRMED', 'AgentAPI did not return a new conversation ID.', { delivery: 'unknown' });
      }
      id = id.toLowerCase();
      active.add(id);
      locked = true;
    }
    delivery = 'accepted';
    emit({ event: 'accepted', conversation_id: id });
    return await waitForReply(id, request, after, deadline);
  } catch (error) {
    const handled = error instanceof CliError ? error : new CliError('UNEXPECTED', error.message);
    throw new CliError(handled.code, handled.message, { ...(id && { conversation_id: id }), delivery, ...handled.details });
  } finally {
    if (locked) active.delete(id);
  }
}

function handleConnection(socket) {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => socket.destroy());
  socket.setEncoding('utf8');
  socket.setTimeout(5000, () => socket.destroy());
  let data = '';

  function emit(message, final = false) {
    if (socket.destroyed) return;
    const line = JSON.stringify(message) + '\n';
    if (final) socket.end(line);
    else socket.write(line);
  }

  function errorResponse(error) {
    const detail = error instanceof CliError ? error : new CliError('INVALID_REQUEST', 'Invalid request JSON.');
    emit({ event: 'error', error: detail.toJSON() }, true);
  }

  function receive(chunk) {
    data += chunk;
    if (Buffer.byteLength(data) > maxRequestBytes) {
      socket.off('data', receive);
      errorResponse(new CliError('REQUEST_TOO_LARGE', 'The local request is too large.'));
      return;
    }
    const newline = data.indexOf('\n');
    if (newline < 0) return;
    socket.off('data', receive);
    socket.setTimeout(0);
    let request;
    try {
      request = validateRequest(JSON.parse(data.slice(0, newline)));
    } catch (error) {
      errorResponse(error);
      return;
    }
    dispatch(request, emit).then(result => emit({ event: 'result', result }, true), errorResponse);
  }
  socket.on('data', receive);
}

async function removeStaleSocket() {
  let before;
  try { before = lstatSync(endpoint); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!before.isSocket() || before.uid !== process.getuid()) throw new Error('The socket path is occupied by a different file.');
  const running = await new Promise((resolve, reject) => {
    const probe = createConnection(endpoint);
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', error => {
      if (['ECONNREFUSED', 'ENOENT'].includes(error.code)) resolve(false);
      else reject(error);
    });
  });
  if (running) throw new Error('The Sidecar socket is already active.');
  try {
    if (lstatSync(endpoint).ino === before.ino) unlinkSync(endpoint);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

process.umask(0o077);
const privateDir = dirname(endpoint);
mkdirSync(privateDir, { recursive: true, mode: 0o700 });
const directory = lstatSync(privateDir);
if (!directory.isDirectory() || directory.uid !== process.getuid()) throw new Error('Invalid Sidecar socket directory.');
chmodSync(privateDir, 0o700);
await removeStaleSocket();

const server = createServer(handleConnection);
server.listen(endpoint, () => {
  chmodSync(endpoint, 0o600);
  console.log('Antigravity Local CLI ready.');
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    for (const socket of sockets) socket.destroy();
    server.close(() => process.exit(0));
  });
}

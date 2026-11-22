import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { parseArgs } from 'node:util';
import { listConversations, readConversation } from './plugin/lib/history.mjs';
import {
  CliError, defaultTimeoutSeconds, maxRequestBytes, protocolVersion, socketPath, validateId, validateRequest,
} from './plugin/lib/protocol.mjs';

const usage = `Antigravity Local CLI

Usage:
  antigravity-local status
  antigravity-local list [--limit N] [--offset N]
  antigravity-local read CONVERSATION_ID [--tail N]
  antigravity-local new --prompt TEXT [--title TITLE] [--model MODEL] [--timeout SECONDS]
  antigravity-local send CONVERSATION_ID --prompt TEXT [--timeout SECONDS]

Use --prompt-file FILE instead of --prompt to read a UTF-8 prompt. Use - for stdin.
New and send wait for the reply. Timeout defaults to ${defaultTimeoutSeconds} seconds.
Commands print JSON to stdout. Errors print JSON to stderr and exit with status 1.
`;

const value = { type: 'string' };
const promptOptions = { prompt: value, 'prompt-file': value, timeout: value };
const commandOptions = {
  status: {},
  list: { limit: value, offset: value },
  read: { tail: value },
  new: { ...promptOptions, title: value, model: value },
  send: promptOptions,
};

function numberOption(input, name, fallback, min, max) {
  if (input === undefined) return fallback;
  const result = /^\d+$/.test(input) ? Number(input) : NaN;
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw new CliError('USAGE', `--${name} must be an integer between ${min} and ${max}.`);
  }
  return result;
}

function getPrompt(values) {
  const fromArg = values.prompt !== undefined;
  const fromFile = values['prompt-file'] !== undefined;
  if (fromArg === fromFile) throw new CliError('USAGE', 'Provide exactly one of --prompt and --prompt-file.');
  if (fromArg) return values.prompt;
  try {
    return readFileSync(values['prompt-file'] === '-' ? 0 : values['prompt-file'], 'utf8');
  } catch (error) {
    throw new CliError('PROMPT_UNAVAILABLE', `Could not read the prompt: ${error.message}`);
  }
}

function callSidecar(request) {
  validateRequest(request);
  const data = JSON.stringify(request) + '\n';
  if (Buffer.byteLength(data) > maxRequestBytes) throw new CliError('REQUEST_TOO_LARGE', 'The prompt and options exceed the local request size limit.');

  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath());
    let connected = false;
    let receipt;
    let buffered = '';
    const timeout = setTimeout(() => disconnected(), (request.timeoutSeconds ?? 1) * 1000 + 5000);

    function finish(error, result) {
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    }

    function disconnected() {
      if (!connected) {
        finish(new CliError('SIDECAR_UNAVAILABLE', 'The Sidecar is unavailable. Open the Antigravity desktop app and enable the Antigravity Local CLI plugin.'));
        return;
      }
      finish(new CliError('SIDECAR_DISCONNECTED', 'The connection closed before completion. Check the conversation before retrying.', {
        ...(request.conversation_id && { conversation_id: request.conversation_id }),
        delivery: 'unknown',
        ...receipt,
      }));
    }

    socket.setEncoding('utf8');
    socket.on('connect', () => {
      connected = true;
      socket.write(data);
    });
    socket.on('error', disconnected);
    socket.on('end', disconnected);
    socket.on('data', chunk => {
      buffered += chunk;
      for (let newline = buffered.indexOf('\n'); newline >= 0; newline = buffered.indexOf('\n')) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { disconnected(); return; }
        if (message.event === 'accepted') {
          receipt = { conversation_id: message.conversation_id, delivery: 'accepted' };
        } else if (message.event === 'result') {
          finish(null, message.result);
          return;
        } else if (message.event === 'error') {
          const { code, message: description, ...details } = message.error;
          finish(new CliError(code, description, details));
          return;
        }
      }
    });
  });
}

async function main([command, ...args]) {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(usage);
    return;
  }
  if (!Object.hasOwn(commandOptions, command)) throw new CliError('USAGE', `Unknown command ${command}. Run with --help.`);
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: { ...commandOptions[command], help: { type: 'boolean', short: 'h' } } });
  } catch (error) {
    throw new CliError('USAGE', error.message);
  }
  const { values, positionals } = parsed;
  if (values.help) { process.stdout.write(usage); return; }
  const needsId = command === 'read' || command === 'send';
  if (positionals.length !== Number(needsId)) {
    throw new CliError('USAGE', `${command} ${needsId ? 'requires one conversation ID' : 'takes no positional arguments'}.`);
  }

  let result;
  if (command === 'list') {
    const limit = numberOption(values.limit, 'limit', 50, 1, 1000);
    const offset = numberOption(values.offset, 'offset', 0, 0, Number.MAX_SAFE_INTEGER - limit);
    result = listConversations(limit, offset);
  } else if (command === 'read') {
    result = readConversation(validateId(positionals[0]));
    const tail = numberOption(values.tail, 'tail', result.steps.length, 1, Number.MAX_SAFE_INTEGER);
    if (tail < result.steps.length) result.steps = result.steps.slice(-tail);
  } else if (command === 'status') {
    result = await callSidecar({ version: protocolVersion, method: command });
  } else {
    result = await callSidecar({
      version: protocolVersion,
      method: command,
      conversation_id: positionals[0],
      prompt: getPrompt(values),
      title: values.title,
      model: values.model,
      timeoutSeconds: numberOption(values.timeout, 'timeout', defaultTimeoutSeconds, 1, 3600),
    });
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  const detail = error instanceof CliError ? error.toJSON() : { code: 'UNEXPECTED', message: error.message };
  process.stderr.write(JSON.stringify({ error: detail }) + '\n');
  process.exitCode = 1;
}

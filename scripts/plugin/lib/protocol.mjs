import { homedir } from 'node:os';
import { join } from 'node:path';

export const appData = join(homedir(), '.gemini', 'antigravity');
export const sidecarId = 'antigravity-local/control';
export const protocolVersion = 1;
export const maxRequestBytes = 256 * 1024;
export const defaultTimeoutSeconds = 120;

export function socketPath(dataDir = join(appData, 'sidecar_data', sidecarId, 'data')) {
  return join(dataDir, 'rpc', 'cli.sock');
}

export class CliError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, ...this.details };
  }
}

export function isConversationId(value) {
  return typeof value === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);
}

export function validateId(value) {
  if (!isConversationId(value)) throw new CliError('INVALID_ID', 'Expected a desktop conversation UUID.');
  return value.toLowerCase();
}

export function validateRequest(request) {
  if (request?.version !== protocolVersion) {
    throw new CliError('PROTOCOL_VERSION', 'The CLI and Sidecar must use the same protocol version.');
  }
  if (request.method === 'status') return { method: 'status' };
  if (!['new', 'send'].includes(request.method)) throw new CliError('INVALID_REQUEST', 'Unknown Sidecar method.');

  const { method, prompt, title, model, timeoutSeconds } = request;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.includes('\0')) {
    throw new CliError('INVALID_PROMPT', 'A nonempty prompt without NUL characters is required.');
  }
  for (const value of [title, model]) {
    if (value !== undefined && (method !== 'new' || typeof value !== 'string' || !value.trim() || value.includes('\0'))) {
      throw new CliError('INVALID_REQUEST', 'Title and model, if provided for new, must be nonempty strings.');
    }
  }
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
    throw new CliError('INVALID_TIMEOUT', 'Timeout must be an integer from 1 to 3600 seconds.');
  }
  const id = method === 'send' ? validateId(request.conversation_id) : undefined;
  return { method, prompt, title, model, timeoutSeconds, id };
}

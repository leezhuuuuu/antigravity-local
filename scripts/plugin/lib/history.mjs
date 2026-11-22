import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { appData, CliError, validateId } from './protocol.mjs';

const columns = `conversation_id, title, project_id, status, step_count,
  last_modified_time AS updated_at`;

function query(sql, parameters, all = false) {
  let db;
  try {
    db = new DatabaseSync(join(appData, 'conversation_summaries.db'), { readOnly: true });
    db.exec('PRAGMA busy_timeout=1000');
    const statement = db.prepare(sql);
    return all ? statement.all(...parameters) : statement.get(...parameters);
  } catch (error) {
    throw new CliError('INDEX_UNAVAILABLE', `Could not read the desktop conversation index: ${error.message}`);
  } finally {
    db?.close();
  }
}

export function getSummary(id) {
  return query(`SELECT ${columns} FROM conversation_summaries WHERE conversation_id = ?`, [validateId(id)]);
}

export function listConversations(limit, offset) {
  const conversations = query(`SELECT ${columns} FROM conversation_summaries
    ORDER BY last_modified_time DESC, conversation_id DESC LIMIT ? OFFSET ?`, [limit + 1, offset], true);
  const hasMore = conversations.length > limit;
  return { conversations: conversations.slice(0, limit), next_offset: hasMore ? offset + limit : null };
}

export function getTranscript(id, previous) {
  const transcriptPath = join(appData, 'brain', validateId(id), '.system_generated', 'logs', 'transcript.jsonl');
  let source;
  let revision;
  try {
    const { ino, size, mtimeNs, ctimeNs } = statSync(transcriptPath, { bigint: true });
    revision = `${ino}:${size}:${mtimeNs}:${ctimeNs}`;
    if (previous?.transcript_path === transcriptPath && previous.revision === revision) return previous;
    source = readFileSync(transcriptPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new CliError('TRANSCRIPT_UNAVAILABLE', `Could not read the desktop transcript: ${error.message}`, { conversation_id: id });
  }

  const byStep = new Map();
  const lines = source.split('\n');
  for (const [position, line] of lines.entries()) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      if (position === lines.length - 1) break; // The App may still be writing the last line.
      throw new CliError('TRANSCRIPT_UNAVAILABLE', `Invalid JSONL at line ${position + 1}.`, { conversation_id: id });
    }
    if (Number.isInteger(entry?.step_index)) byStep.set(entry.step_index, entry);
  }
  return { revision, transcript_path: transcriptPath, steps: [...byStep.values()].sort((a, b) => a.step_index - b.step_index) };
}

export function readConversation(id) {
  const transcript = getTranscript(id);
  let conversation;
  try {
    conversation = getSummary(id);
  } catch (error) {
    // A read-only sandbox may block SQLite's shared-memory file while allowing transcript reads.
    if (!transcript || error.code !== 'INDEX_UNAVAILABLE') throw error;
  }
  if (!conversation && !transcript) throw new CliError('NOT_FOUND', 'Desktop conversation not found.', { conversation_id: id });
  if (!transcript) throw new CliError('NO_TRANSCRIPT', 'The desktop index has this conversation, but its local transcript is unavailable.', { conversation_id: id });
  const { transcript_path, steps } = transcript;
  return { conversation: conversation ?? { conversation_id: id }, transcript_path, steps };
}

const explicitInput = /^<USER_REQUEST>\n([\s\S]*)\n<\/USER_REQUEST>(?:\n<ADDITIONAL_METADATA>[\s\S]*|\n|$)/;
const sidecarInput = /(?:^|\n)\[Message\] [^\n]*? priority=(\S+) content=([\s\S]*)\n<\/SYSTEM_MESSAGE>\s*$/;

function messageText(step) {
  if (typeof step.content !== 'string') return null;
  const content = step.content.replaceAll('\r\n', '\n');
  if (step.type === 'USER_INPUT') return explicitInput.exec(content)?.[1] ?? content;
  if (step.type === 'SYSTEM_MESSAGE') {
    const message = sidecarInput.exec(content);
    // AgentAPI sends high-priority messages. The App also logs low-priority notices between turns.
    return message?.[1] === 'MESSAGE_PRIORITY_HIGH' ? message[2] : null;
  }
  return null;
}

export function findTurn(steps, { after, method, prompt }) {
  const expectedType = method === 'send' ? 'SYSTEM_MESSAGE' : 'USER_INPUT';
  const input = steps.find(step => step.step_index > after && step.type === expectedType
    && messageText(step) === prompt.replaceAll('\r\n', '\n'));
  if (!input) return {};
  const following = steps.filter(step => step.step_index > input.step_index);
  const nextInput = following.find(step => messageText(step) !== null);
  const replies = nextInput ? following.filter(step => step.step_index < nextInput.step_index) : following;
  const reply = replies.findLast(step => step.type === 'PLANNER_RESPONSE'
    && step.status === 'DONE' && typeof step.content === 'string' && step.content.trim());
  const failure = replies.findLast(step => step.type === 'ERROR_MESSAGE' && step.content);
  return { input, reply, nextInput, failure };
}

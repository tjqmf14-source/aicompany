import { CoreError } from '../core/domain.js';

export interface NewFile { path: string; content: string }
export interface CodexTaskSpec { title: string; description: string; acceptanceCriteria: string[] }
export interface HighResponse {
  summary: string;
  decisions: string[];
  patches: string[];
  newFiles: NewFile[];
  commands: string[];
  tests: string[];
  codexTasks: CodexTaskSpec[];
  remainingTasks: string[];
  questions: string[];
  riskNotes: string[];
}
export type RiskClass = 'SAFE' | 'REVIEW' | 'DANGEROUS';
export interface ClassifiedCommand { command: string; risk: RiskClass; reason: string; approvalId?: string }

function record(value: unknown, fields: readonly string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CoreError('INVALID_INPUT', `${name} must be an object`);
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).some(key => !fields.includes(key))) throw new CoreError('INVALID_INPUT', `${name} contains unknown fields`);
  for (const field of fields) if (!(field in obj)) throw new CoreError('INVALID_INPUT', `${name}.${field} is required`);
  return obj;
}
function str(value: unknown, name: string, max = 20_000): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new CoreError('INVALID_INPUT', `${name} must be a string of at most ${max} characters`);
  return value;
}
function list(value: unknown, name: string, max = 100, itemMax = 20_000): string[] {
  if (!Array.isArray(value) || value.length > max) throw new CoreError('INVALID_INPUT', `${name} must be an array of at most ${max} strings`);
  return value.map((item, index) => str(item, `${name}[${index}]`, itemMax));
}

const fields = ['summary', 'decisions', 'patches', 'newFiles', 'commands', 'tests', 'codexTasks', 'remainingTasks', 'questions', 'riskNotes'] as const;

export function validateHighResponse(value: unknown): HighResponse {
  const obj = record(value, fields, 'HighResponse');
  if (!Array.isArray(obj.newFiles) || obj.newFiles.length > 100) throw new CoreError('INVALID_INPUT', 'newFiles must be an array');
  if (!Array.isArray(obj.codexTasks) || obj.codexTasks.length > 100) throw new CoreError('INVALID_INPUT', 'codexTasks must be an array');
  const newFiles = obj.newFiles.map((item, index) => {
    const file = record(item, ['path', 'content'], `newFiles[${index}]`);
    return { path: str(file.path, `newFiles[${index}].path`, 500), content: str(file.content, `newFiles[${index}].content`, 1_000_000) };
  });
  const codexTasks = obj.codexTasks.map((item, index) => {
    const task = record(item, ['title', 'description', 'acceptanceCriteria'], `codexTasks[${index}]`);
    const title = str(task.title, `codexTasks[${index}].title`, 300).trim();
    if (!title) throw new CoreError('INVALID_INPUT', 'Codex task title is empty');
    return { title, description: str(task.description, `codexTasks[${index}].description`), acceptanceCriteria: list(task.acceptanceCriteria, `codexTasks[${index}].acceptanceCriteria`, 30, 1000) };
  });
  const result: HighResponse = {
    summary: str(obj.summary, 'summary'),
    decisions: list(obj.decisions, 'decisions'),
    patches: list(obj.patches, 'patches', 50, 1_000_000),
    newFiles, commands: list(obj.commands, 'commands', 100, 2_000),
    tests: list(obj.tests, 'tests'), codexTasks,
    remainingTasks: list(obj.remainingTasks, 'remainingTasks'),
    questions: list(obj.questions, 'questions'), riskNotes: list(obj.riskNotes, 'riskNotes'),
  };
  if (JSON.stringify(result).length > 4_000_000) throw new CoreError('INVALID_INPUT', 'HighResponse exceeds 4 MiB');
  return result;
}

export function classifyCommand(command: string): ClassifiedCommand {
  const trimmed = command.trim();
  if (!trimmed) return { command, risk: 'REVIEW', reason: 'Empty command' };
  if (/[;&|><`\r\n]/.test(trimmed) || /\$\(|\$\{|%[^%]+%/.test(trimmed)
    || /\b(?:rm|del|erase|rmdir|remove-item|format|shutdown|restart-computer|invoke-expression|iex|curl|wget|invoke-webrequest|iwr|powershell|pwsh|cmd)\b/i.test(trimmed)
    || /^git\s+(?:reset|clean|push|checkout|switch|branch\s+-D|rebase|filter-branch)\b/i.test(trimmed)
    || /^npm\s+(?:install|uninstall|publish|exec|npx|audit\s+fix)\b/i.test(trimmed)) {
    return { command, risk: 'DANGEROUS', reason: 'Shell composition, external execution or destructive command' };
  }
  if (/^(?:git\s+(?:status|diff|log|rev-parse)(?:\s+[\w./=:-]+)*|git\s+--version|node\s+--version|npm\s+--version)$/.test(trimmed)) {
    return { command, risk: 'SAFE', reason: 'Read-only allowlisted command' };
  }
  if (/^npm(?:\.cmd)?\s+run\s+(?:typecheck|lint|test|build)$/.test(trimmed) || /^git\s+add\s+--\s+[\w./-]+$/.test(trimmed)) {
    return { command, risk: 'REVIEW', reason: 'Known local operation requiring human review' };
  }
  return { command, risk: 'DANGEROUS', reason: 'Unrecognized command requires explicit approval; never executed automatically' };
}

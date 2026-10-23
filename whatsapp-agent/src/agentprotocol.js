// Small, pure helpers for bounded tool requests and safe tool-call decoding.
import { BrainError } from './brainrequest.js';

export function shorten(value, max = 1800) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  const marker = '\n[…shortened…]\n';
  const head = Math.max(0, Math.floor((max - marker.length) * 0.7));
  return text.slice(0, head) + marker + text.slice(-(max - marker.length - head));
}

export function compactSchema(schema, maxDescription = 220) {
  if (Array.isArray(schema)) return schema.map((value) => compactSchema(value, maxDescription));
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema).map(([key, value]) => [
    key, key === 'description' && typeof value === 'string' ? shorten(value, maxDescription) : compactSchema(value, maxDescription),
  ]));
}

// Keep the current task, system safety rules and assistant/tool-call pairing.
// Only optional old chat and already-observed result text may be shortened.
export function fitAgentMessages(messages, tools, { maxChars = 24_000, historyCount = 0, compact = false } = {}) {
  let result = messages.map((message) => ({ ...message }));
  const size = () => JSON.stringify({ messages: result, tools }).length;
  if (compact || size() > maxChars) result = result.filter((_m, i) => i === 0 || i > historyCount);
  if (compact || size() > maxChars) {
    result = result.map((message) => {
      if (message.role === 'tool') return { ...message, content: shorten(message.content, compact ? 500 : 1200) };
      if (message.role === 'assistant') return { ...message, content: shorten(message.content, compact ? 250 : 600) };
      return message;
    });
  }
  if (size() > maxChars) {
    throw new BrainError('Request too large: task and tool context exceed AGENT_PROMPT_MAX_CHARS; use a file path for large code/data or raise the budget.', { status: 413 });
  }
  return result;
}

export function stableSignature(name, args) {
  const sorted = (value) => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value;
  return `${name}:${JSON.stringify(sorted(args))}`;
}

/** Never turn malformed JSON into {} and then execute a default action. */
export function decodeToolArgs(raw) {
  try {
    const args = typeof raw === 'string' ? JSON.parse(raw) : raw ?? {};
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments must be a JSON object');
    return { args, error: '' };
  } catch (err) {
    return { args: {}, error: `Invalid tool arguments: ${err.message}` };
  }
}

export function validateToolArgs(args, schema = {}, path = 'arguments', depth = 0) {
  if (depth > 12) return `${path} is nested too deeply`;
  const type = schema.type;
  const valid = type === 'object' ? args != null && typeof args === 'object' && !Array.isArray(args)
    : type === 'array' ? Array.isArray(args)
      : type === 'integer' ? Number.isInteger(args)
        : type === 'number' ? typeof args === 'number' && Number.isFinite(args)
          : type ? typeof args === type : true;
  if (!valid) return `${path} must be ${type}`;
  if (schema.enum && !schema.enum.includes(args)) return `${path} must be one of: ${schema.enum.join(', ')}`;
  if (type === 'object') {
    for (const key of schema.required ?? []) if (!Object.hasOwn(args, key)) return `${path}.${key} is required`;
    for (const [key, value] of Object.entries(args)) {
      if (schema.additionalProperties === false && !Object.hasOwn(schema.properties ?? {}, key)) return `${path}.${key} is not allowed`;
      const error = validateToolArgs(value, schema.properties?.[key] ?? {}, `${path}.${key}`, depth + 1);
      if (error) return error;
    }
  }
  if (type === 'array' && schema.items) {
    for (let i = 0; i < args.length; i++) {
      const error = validateToolArgs(args[i], schema.items, `${path}[${i}]`, depth + 1);
      if (error) return error;
    }
  }
  return '';
}

const TOOL_GROUPS = [
  [/\b(file|files|folder|directory|path|csv|pdf|notes|downloads?|report|script|code|python)\b|~\//i, ['list_dir', 'read_file', 'write_file', 'search_files', 'send_file', 'make_dir']],
  [/\b(code|coding|script|python|javascript|typescript|debug|refactor|bug|compile|repository|repo|implement)\b/i, ['dsh_run', 'run_shell', 'read_file', 'write_file', 'list_dir']],
  [/\b(research|search|dhundo|dhoondo|find|compare|news|web|internet|scrape)\b/i, ['web_search', 'read_url', 'reach_research']],
  [/\b(github|repo|repository|pull.request|issue)\b/i, ['github_lookup', 'read_url', 'web_search']],
  [/\b(youtube|video|transcript|lofi)\b/i, ['youtube_info']],
  [/\b(screen|desktop|click|type|paste|scroll|keyboard|browser|settings|kholo|open|launch)\b/i, ['computer_use', 'inspect_ui', 'open_app', 'type_text', 'paste_text', 'press_keys', 'focus_window']],
  [/\b(screenshot|capture|screen|bhej|bhejo|send|share)\b/i, ['screenshot', 'send_file']],
  [/\b(delete|remove|saaf|hatao|hata|clean|trash)\b/i, ['list_dir', 'delete_path', 'search_files']],
  [/\b(move|rename|organize|organise|sort|copy|backup|zip|extract|unzip)\b/i, ['move_path', 'copy_path', 'make_dir', 'zip_paths', 'unzip_path', 'list_dir']],
  [/\b(download|url|https?)\b/i, ['download_url', 'read_url']],
  [/\b(whatsapp|message|contact|msg)\b/i, ['send_whatsapp', 'manage_contacts']],
  [/\b(remind|reminder|yaad|schedule|call|todo|note)\b/i, ['add_reminder', 'schedule_jarvis_call', 'add_todo', 'add_note']],
  [/\b(volume|sound|audio|mute|awaz)\b/i, ['volume', 'media']],
  [/\b(wifi|bluetooth|network|internet)\b/i, ['wifi', 'bluetooth', 'network_info']],
  [/\b(calculate|solve|equation|math|verify|answer|sawal)\b/i, ['verify_answer', 'calculate', 'solve_question']],
  [/\b(command|custom|learn|seekh|remember|preference|naam)\b/i, ['create_custom_command', 'remember_fact', 'update_owner_profile']],
];
const ESSENTIAL = new Set(['computer_use', 'open_app', 'system_status', 'read_file', 'write_file', 'web_search', 'read_url', 'screenshot', 'send_file']);

export function selectAgentTools(allTools, text, limit) {
  const query = String(text ?? '').toLowerCase();
  const words = [...new Set(query.split(/[^a-z0-9_]+/).filter((word) => word.length > 2))];
  const relevant = new Set(TOOL_GROUPS.filter(([pattern]) => pattern.test(query)).flatMap(([, names]) => names));
  return allTools.map((tool) => {
    const haystack = `${tool.name} ${tool.description ?? ''}`.toLowerCase();
    const score = (relevant.has(tool.name) ? 60 : 0) + (ESSENTIAL.has(tool.name) ? 2 : 0)
      + words.reduce((sum, word) => sum + (tool.name.includes(word) ? 8 : haystack.includes(word) ? 1 : 0), 0);
    return { tool, score };
  }).sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, Math.max(1, limit)).map(({ tool }) => tool);
}

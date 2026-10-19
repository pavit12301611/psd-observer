// src/mcp/validate.ts
//
// Minimal hand-rolled JSON-Schema argument validation. We avoid adding a dependency
// (zod etc.) since the schemas here are shallow. Validates required keys and top-level
// property types; unknown properties are ignored.

import type { ToolDefinition } from './types';

export interface ValidationResult {
  ok: boolean;
  value?: any;
  error?: string;
}

function checkType(value: any, type: string | undefined): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && !Number.isNaN(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    default: return true; // unknown/unspecified type → accept
  }
}

/**
 * Parse + validate a raw JSON arguments string against a tool's parameter schema.
 */
export function validateArgs(tool: ToolDefinition, rawArgs: string): ValidationResult {
  let parsed: any;
  try {
    parsed = rawArgs && rawArgs.trim() ? JSON.parse(rawArgs) : {};
  } catch (e) {
    // Some models (e.g. Gemini flash) emit concatenated empty objects like "{}{}{}" for
    // no-parameter tools. If the tool has no required params, fall back to {} silently.
    const required = tool.parameters.required || [];
    if (required.length === 0) {
      parsed = {};
    } else {
      return { ok: false, error: `Invalid JSON arguments: ${(e as Error).message}` };
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'Arguments must be a JSON object' };
  }

  const schema = tool.parameters;
  const required = schema.required || [];
  for (const key of required) {
    if (!(key in parsed) || parsed[key] === undefined || parsed[key] === null) {
      return { ok: false, error: `Missing required parameter: ${key}` };
    }
  }

  for (const [key, value] of Object.entries(parsed)) {
    const propSchema = schema.properties[key];
    if (!propSchema) continue; // ignore unknown props
    if (value === undefined || value === null) continue; // optional/null tolerated
    if (!checkType(value, propSchema.type)) {
      return { ok: false, error: `Parameter '${key}' should be of type ${propSchema.type}` };
    }
  }

  return { ok: true, value: parsed };
}

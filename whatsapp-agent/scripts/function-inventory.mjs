// AST inventory, not execution: names, exact source spans and export context.
import { parse } from 'acorn';
const functions = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
export function inventory(source) {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  const rows = [];
  const key = (node) => node?.name ?? node?.value ?? '';
  function walk(node, ancestors = []) {
    if (!node || typeof node.type !== 'string') return;
    const parent = ancestors.at(-1);
    if (functions.has(node.type)) {
      const method = ['MethodDefinition', 'Property', 'PropertyDefinition'].includes(parent?.type);
      const binding = parent?.type === 'VariableDeclarator' ? key(parent.id) : method ? String(key(parent.key)) : '';
      const owner = [...ancestors].reverse().find((x) => ['ClassDeclaration', 'ClassExpression'].includes(x.type));
      const name = node.id?.name || (owner?.id?.name && method ? `${owner.id.name}.${binding}` : binding) || `anonymous@${node.loc.start.line}:${node.loc.start.column}`;
      const range = parent?.type === 'MethodDefinition' ? parent.loc : node.loc;
      rows.push({ name, kind: node.type, line: range.start.line, column: range.start.column, endLine: range.end.line, endColumn: range.end.column, async: Boolean(node.async), generator: Boolean(node.generator), exportContext: ancestors.some((x) => x.type === 'ExportNamedDeclaration' || x.type === 'ExportDefaultDeclaration') });
    }
    const next = [...ancestors, node];
    for (const [name, value] of Object.entries(node)) {
      if (name === 'loc') continue;
      if (Array.isArray(value)) {
        for (const child of value) if (child?.type) walk(child, next);
      } else if (value?.type) walk(value, next);
    }
  }
  walk(ast);
  return rows;
}

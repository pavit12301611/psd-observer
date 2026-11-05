// test/fake-brain.mjs — a deterministic OpenAI-compatible model, used by tests
// to prove the agent loop end to end without downloading a 5 GB GGUF.
//
// It behaves like a real tool-calling model: first turn it emits a tool call,
// it reads the tool result, then it answers in words. Streaming SSE included.

import http from 'node:http';

export function startFakeBrain({ port = 0, plan = null } = {}) {
  const calls = [];
  const script = plan ?? [
    { tool: 'system_status', args: {} },
    { text: 'Memory is fine and the machine is idle.' },
  ];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'fake-brain-1' }] }));
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      calls.push(body);
      const hasToolResult = (body.messages ?? []).some((m) => m.role === 'tool');
      const step = script.find((entry) => (entry.tool && !hasToolResult) || (entry.text && hasToolResult)) ?? script.at(-1);

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });

      const write = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

      if (step.tool) {
        write({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_fake_1', type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args ?? {}) } }] } }] });
        write({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        for (const word of String(step.text).split(' ')) {
          write({ choices: [{ index: 0, delta: { content: `${word} ` } }] });
        }
        write({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      }
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({
        url: `http://127.0.0.1:${actual}/v1`,
        port: actual,
        calls,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const brain = await startFakeBrain({ port: Number(process.argv[2]) || 7799 });
  console.log(`fake brain on ${brain.url}`);
}

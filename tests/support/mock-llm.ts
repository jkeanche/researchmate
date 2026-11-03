import { createServer, type IncomingMessage, type Server } from "node:http";

/**
 * A minimal OpenAI-compatible chat-completions server for tests. Replies are
 * taken from a queue (or a responder function); both JSON and SSE streaming
 * responses are supported, with token usage. Records every request so tests
 * can assert what was sent (model, key, messages).
 */
export interface MockLlm {
  url: string;
  requests: { headers: IncomingMessage["headers"]; body: Record<string, unknown> }[];
  reply: (content: string | ((body: Record<string, unknown>) => string)) => void;
  failNext: (status: number, message: string) => void;
  close: () => Promise<void>;
}

export async function startMockLlm(): Promise<MockLlm> {
  const queue: (string | ((b: Record<string, unknown>) => string))[] = [];
  const failures: { status: number; message: string }[] = [];
  const requests: MockLlm["requests"] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    requests.push({ headers: req.headers, body });
    if (!req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    const fail = failures.shift();
    if (fail) {
      res.writeHead(fail.status, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: fail.message, type: "invalid_request_error" } }));
      return;
    }
    const next = queue.shift() ?? "OK";
    const content = typeof next === "function" ? next(body) : next;
    // "TOOL:{"name":"list_tasks","args":{}}" replies with a tool call instead of text.
    if (content.startsWith("TOOL:") && !body.stream) {
      const call = JSON.parse(content.slice(5)) as { name: string; args: unknown };
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: String(body.model),
          choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: `call_${requests.length}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] }, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
        }),
      );
      return;
    }
    const usage = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 };
    const model = String(body.model ?? "mock");
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const base = { id: "chatcmpl-mock", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
      send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
      for (let i = 0; i < content.length; i += 40) send({ ...base, choices: [{ index: 0, delta: { content: content.slice(i, i + 40) }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage });
      res.end("data: [DONE]\n\n");
    } else {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage }),
      );
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    reply: (c) => queue.push(c),
    failNext: (status, message) => failures.push({ status, message }),
    close: () => new Promise((r) => server.close(() => r())),
  };
}

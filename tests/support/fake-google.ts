import { createServer, type Server } from "node:http";

/** A small fake of Google's OAuth token endpoint and the Drive v3 API, for tests. */
export interface FakeFile { id: string; name: string; mimeType: string; content: Buffer; md5?: string; modifiedTime: string }

export async function startFakeGoogle() {
  const files = new Map<string, FakeFile>();
  const state = { revoked: [] as string[], refreshCount: 0, refreshRevoked: false, uploads: [] as { metadata: Record<string, unknown>; bytes: number }[], lastAuth: "" };
  let access = 0;
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url!, "http://x");
    const json = (code: number, o: unknown) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(o));
    if (url.pathname === "/token") {
      const p = new URLSearchParams(raw.toString());
      if (p.get("grant_type") === "authorization_code") {
        if (p.get("code") !== "good-code" || !p.get("code_verifier")) return json(400, { error: "invalid_grant" });
        return json(200, { access_token: `at-${++access}`, refresh_token: "rt-secret", expires_in: 3600, scope: "https://www.googleapis.com/auth/drive.file" });
      }
      if (p.get("grant_type") === "refresh_token") {
        if (state.refreshRevoked) return json(400, { error: "invalid_grant" });
        state.refreshCount++;
        return json(200, { access_token: `at-${++access}`, expires_in: 3600 });
      }
      return json(400, { error: "unsupported_grant_type" });
    }
    if (url.pathname === "/revoke") {
      state.revoked.push(new URLSearchParams(raw.toString()).get("token") ?? "");
      return json(200, {});
    }
    state.lastAuth = String(req.headers.authorization ?? "");
    if (!state.lastAuth.startsWith("Bearer at-")) return json(401, { error: "unauthorized" });
    if (url.pathname === "/drive/v3/about") return json(200, { user: { emailAddress: "researcher@gmail.test" } });
    if (url.pathname === "/drive/v3/files" && req.method === "GET") {
      return json(200, { files: [...files.values()].map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, size: String(f.content.length), md5Checksum: f.md5, modifiedTime: f.modifiedTime })) });
    }
    const m = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)(\/export)?$/);
    if (m) {
      const f = files.get(decodeURIComponent(m[1]!));
      if (!f) return json(404, { error: "notFound" });
      if (m[2] || url.searchParams.get("alt") === "media") return res.writeHead(200, { "content-type": "application/octet-stream" }).end(f.content);
      return json(200, { id: f.id, name: f.name, mimeType: f.mimeType, size: f.mimeType.startsWith("application/vnd.google-apps") ? undefined : String(f.content.length), md5Checksum: f.md5, modifiedTime: f.modifiedTime, webViewLink: `https://drive.test/${f.id}` });
    }
    if (url.pathname === "/upload/drive/v3/files" && url.searchParams.get("uploadType") === "multipart") {
      const boundary = String(req.headers["content-type"]).split("boundary=")[1]!;
      const parts = raw.toString("latin1").split(`--${boundary}`);
      const metadata = JSON.parse(parts[1]!.split("\r\n\r\n")[1]!.trim());
      const content = parts[2]!.split("\r\n\r\n").slice(1).join("\r\n\r\n").replace(/\r\n$/, "");
      state.uploads.push({ metadata, bytes: Buffer.from(content, "latin1").length });
      return json(200, { id: `exported${state.uploads.length}abcdef`, name: metadata.name, mimeType: "application/pdf", webViewLink: "https://drive.test/exported" });
    }
    json(404, { error: "notFound" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    files,
    state,
    endpoints: { auth: `${base}/auth`, token: `${base}/token`, revoke: `${base}/revoke`, api: `${base}/drive/v3`, upload: `${base}/upload/drive/v3` },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

import { connect } from "node:net";

export interface MalwareScanner {
  /** Resolves to null when clean, or the signature name when infected. Throws if the scanner can't be reached. */
  scan(chunks: AsyncIterable<Uint8Array>): Promise<string | null>;
}

/**
 * clamd client using the INSTREAM command (zINSTREAM\0, then length-prefixed
 * chunks, then a zero-length chunk). Reply: "stream: OK" or
 * "stream: <signature> FOUND". See clamd(8).
 */
export class ClamAvScanner implements MalwareScanner {
  constructor(private readonly opts: { host: string; port: number; timeoutMs?: number; maxChunk?: number }) {}

  scan(chunks: AsyncIterable<Uint8Array>): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.opts.host, port: this.opts.port });
      socket.setTimeout(this.opts.timeoutMs ?? 60_000);
      let reply = "";
      let settled = false;
      const finish = (err: Error | null, value?: string | null) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (err) reject(err);
        else resolve(value ?? null);
      };
      socket.on("timeout", () => finish(new Error("Malware scanner timed out")));
      socket.on("error", (e) => finish(new Error(`Malware scanner unavailable: ${e.message}`)));
      socket.on("data", (d) => (reply += d.toString("utf8")));
      socket.on("end", () => {
        const text = reply.replace(/\0/g, "").trim();
        if (/: OK$/.test(text)) return finish(null, null);
        const found = text.match(/: (.+) FOUND$/);
        if (found) return finish(null, found[1]!);
        finish(new Error(`Unexpected malware scanner reply: ${text.slice(0, 200)}`));
      });
      socket.on("connect", async () => {
        try {
          const write = (b: Buffer) => new Promise<void>((res, rej) => socket.write(b, (e) => (e ? rej(e) : res())));
          await write(Buffer.from("zINSTREAM\0"));
          const max = this.opts.maxChunk ?? 64 * 1024;
          for await (const c of chunks) {
            const buf = Buffer.from(c);
            for (let i = 0; i < buf.length; i += max) {
              const part = buf.subarray(i, i + max);
              const len = Buffer.alloc(4);
              len.writeUInt32BE(part.length);
              await write(Buffer.concat([len, part]));
            }
          }
          await write(Buffer.alloc(4)); // end of stream
        } catch (e) {
          finish(e as Error);
        }
      });
    });
  }
}

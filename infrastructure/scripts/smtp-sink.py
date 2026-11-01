#!/usr/bin/env python3
"""
Minimal SMTP sink for local end-to-end testing (never for production).

Accepts every message on 127.0.0.1:PORT and appends the decoded text/plain
body to a log file, so E2E tests can follow verification and reset links.

    python3 infrastructure/scripts/smtp-sink.py --port 2525 --out /var/tmp/mail.log
"""
import argparse
import asyncio
import email
from email import policy


async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, out: str) -> None:
    def send(line: str) -> None:
        writer.write((line + "\r\n").encode())

    send("220 researchmate-smtp-sink ready")
    await writer.drain()
    rcpts: list[str] = []
    while True:
        raw = await reader.readline()
        if not raw:
            break
        cmd = raw.decode(errors="replace").strip()
        upper = cmd.upper()
        if upper.startswith(("EHLO", "HELO")):
            send("250-sink")
            send("250 AUTH PLAIN LOGIN")
        elif upper.startswith("AUTH"):
            send("235 ok")
        elif upper.startswith("MAIL FROM"):
            rcpts = []
            send("250 ok")
        elif upper.startswith("RCPT TO"):
            rcpts.append(cmd.split(":", 1)[1].strip().strip("<>"))
            send("250 ok")
        elif upper == "DATA":
            send("354 end with .")
            await writer.drain()
            lines = []
            while True:
                l = await reader.readline()
                if l in (b".\r\n", b".\n", b""):
                    break
                lines.append(l[1:] if l.startswith(b"..") else l)
            msg = email.message_from_bytes(b"".join(lines), policy=policy.default)
            part = msg.get_body(preferencelist=("plain",))
            body = part.get_content() if part else ""
            with open(out, "a", encoding="utf-8") as f:
                for r in rcpts:
                    f.write(f"\n──── email\nTo: {r}\nSubject: {msg['subject']}\n\n{body}\n")
            send("250 queued")
        elif upper == "QUIT":
            send("221 bye")
            await writer.drain()
            break
        else:
            send("250 ok")
        await writer.drain()
    writer.close()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=2525)
    ap.add_argument("--out", default="/var/tmp/mail.log")
    a = ap.parse_args()

    async def run() -> None:
        server = await asyncio.start_server(lambda r, w: handle(r, w, a.out), "127.0.0.1", a.port)
        async with server:
            await server.serve_forever()

    asyncio.run(run())


if __name__ == "__main__":
    main()

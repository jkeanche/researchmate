import Link from "next/link";

/** Wordmark: a ruled-page glyph with a margin line, plus the name set in Literata. */
export function Wordmark({ href = "/", compact = false }: { href?: string; compact?: boolean }) {
  return (
    <Link href={href} className="inline-flex items-center gap-2 no-underline" aria-label="ResearchMate AI home">
      <svg width="22" height="26" viewBox="0 0 22 26" aria-hidden="true">
        <rect x="0.75" y="0.75" width="20.5" height="24.5" rx="2" fill="#fff" stroke="#1b2a3a" strokeWidth="1.5" />
        <line x1="6" y1="1" x2="6" y2="25" stroke="#b23a3a" strokeWidth="1.2" />
        <line x1="8.5" y1="8" x2="18" y2="8" stroke="#cad6e2" strokeWidth="1.2" />
        <line x1="8.5" y1="12.5" x2="18" y2="12.5" stroke="#cad6e2" strokeWidth="1.2" />
        <line x1="8.5" y1="17" x2="15" y2="17" stroke="#2f6b4f" strokeWidth="1.6" />
      </svg>
      {!compact && <span className="font-serif text-[1.15rem] font-semibold tracking-tight">ResearchMate</span>}
    </Link>
  );
}

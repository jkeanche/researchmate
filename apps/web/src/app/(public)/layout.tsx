import Link from "next/link";
import { Wordmark } from "@/components/brand";

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-5">
        <Wordmark />
        <nav className="flex items-center gap-1 text-[0.9375rem]">
          <Link href="/#pricing" className="hidden px-3 py-2 sm:inline">Pricing</Link>
          <Link href="/login" className="px-3 py-2">Sign in</Link>
        </nav>
      </header>
      <main className="mx-auto w-full max-w-2xl flex-1 px-5 pt-6 pb-16">{children}</main>
    </div>
  );
}

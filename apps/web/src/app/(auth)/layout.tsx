import { Wordmark } from "@/components/brand";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center px-5 py-10">
      <div className="mb-8">
        <Wordmark />
      </div>
      <main className="margin-rule w-full max-w-md rounded-md border border-rule bg-sheet py-8 pr-7 pl-10">{children}</main>
    </div>
  );
}

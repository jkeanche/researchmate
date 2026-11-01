import Link from "next/link";
import { Wordmark } from "@/components/brand";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-5 text-center">
      <Wordmark />
      <h1 className="text-3xl">Page not found</h1>
      <p className="max-w-md text-graphite">The page doesn't exist, or you don't have access to it. If someone shared a link, ask them to add you to the project.</p>
      <Link href="/app" className="btn btn-primary">Go to your dashboard</Link>
    </div>
  );
}

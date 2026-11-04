import { isPlatformAdmin } from "@researchmate/admin";
import { notFound } from "next/navigation";
import { AdminNav } from "@/components/admin-nav";
import { db, supportService } from "@/server/services";
import { requireSession } from "@/server/session";

export const dynamic = "force-dynamic";

/** Platform administration. Anyone else gets a plain 404 (the area isn't advertised). */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const s = await requireSession();
  if (!(await isPlatformAdmin(db(), s.user.id))) notFound();
  const counts = await supportService().counts(s.user.id);
  return (
    <>
      <p className="mb-1 text-xs font-semibold tracking-wide text-graphite uppercase">Platform administration</p>
      <AdminNav openEnquiries={counts.open} />
      {children}
    </>
  );
}

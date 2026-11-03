import { searchProjects } from "@researchmate/research";
import { SearchForm, SearchResults } from "@/components/search-results";
import { PageHeader } from "@/components/ui";
import { db } from "@/server/services";
import { requireWorkspace } from "@/server/session";

export const metadata = { title: "Search" };

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { session, org } = await requireWorkspace();
  const q = ((await searchParams).q ?? "").trim().slice(0, 200);
  const r = q.length >= 2 ? await searchProjects(db(), session.user.id, { organizationId: org.organizationId }, q) : { hits: [], searchedProjects: 0 };
  return (
    <>
      <PageHeader title="Search" description="Across every active project you can open in this workspace." />
      <SearchForm q={q} label="Search all projects" />
      <SearchResults hits={r.hits} q={q} showProject />
    </>
  );
}

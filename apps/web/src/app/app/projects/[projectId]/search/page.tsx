import { searchProjects } from "@researchmate/research";
import { SearchForm, SearchResults } from "@/components/search-results";
import { loadProject } from "@/server/plan";
import { db } from "@/server/services";

export const metadata = { title: "Search project" };

export default async function ProjectSearchPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ q?: string }> }) {
  const { projectId } = await params;
  const p = await loadProject(projectId);
  const q = ((await searchParams).q ?? "").trim().slice(0, 200);
  const { hits } = q.length >= 2 ? await searchProjects(db(), p.session.user.id, { projectId }, q) : { hits: [] };
  return (
    <>
      <SearchForm q={q} label="Search this project" />
      <SearchResults hits={hits} q={q} showProject={false} />
    </>
  );
}

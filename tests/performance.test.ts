import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeTestDb, testDb } from "./helpers";

afterAll(closeTestDb);

/** Referenced tables whose FKs don't need an index: users are never hard-deleted; catalogue rows are never deleted. */
const EXEMPT_REFERENCED = ["users", "roles", "plans", "price_points", "pricing_versions", "workflow_templates", "document_templates", "apify_actors"];

describe("database performance guards", () => {
  it("every foreign key used for joins or cascading deletes has a supporting index", async () => {
    const rows = (await testDb().execute(sql`
      with fk as (
        select c.conrelid, c.conkey, c.conrelid::regclass::text as tbl, c.confrelid::regclass::text as ref,
               (select string_agg(a.attname, ',' order by k.ord) from unnest(c.conkey) with ordinality k(attnum, ord)
                  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as cols
        from pg_constraint c where c.contype = 'f' and c.connamespace = 'public'::regnamespace)
      select fk.tbl || '(' || fk.cols || ') -> ' || fk.ref as missing from fk
      where not exists (select 1 from pg_index i where i.indrelid = fk.conrelid and (i.indkey::int2[])[0:array_length(fk.conkey, 1) - 1] = fk.conkey)
        and fk.ref <> all(${`{${EXEMPT_REFERENCED.join(",")}}`}::text[])
      order by 1`)) as unknown as { missing: string }[];
    expect(rows.map((r) => r.missing)).toEqual([]);
  });

  it("tenant-scoped hot paths use indexes", async () => {
    // With the planner forced away from sequential scans, each query must still find an index.
    const plans: string[] = [];
    await testDb().transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      for (const q of [
        sql`explain select * from notifications where user_id = '00000000-0000-0000-0000-000000000001'::uuid and in_app and read_at is null order by created_at desc limit 50`,
        sql`explain select * from research_tasks where project_id = '00000000-0000-0000-0000-000000000001'::uuid order by sort_order`,
        sql`explain select * from files where organization_id = '00000000-0000-0000-0000-000000000001'::uuid and deleted_at is null`,
        sql`explain select * from file_passages where search @@ websearch_to_tsquery('english', 'savings')`,
        sql`explain select * from "references" where project_id = '00000000-0000-0000-0000-000000000001'::uuid`,
        sql`explain select * from audit_logs where organization_id = '00000000-0000-0000-0000-000000000001'::uuid order by created_at desc limit 50`,
      ]) plans.push(((await tx.execute(q)) as unknown as { "QUERY PLAN": string }[]).map((r) => r["QUERY PLAN"]).join("\n"));
    });
    for (const p of plans) expect(p, p).toMatch(/Index|Bitmap/);
  });
});

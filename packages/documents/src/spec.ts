import type { DocumentSpec } from "@researchmate/database";
import { z } from "zod";

const mm = z.coerce.number().min(5).max(60);
const nullableInt = (max: number) => z.union([z.coerce.number().int().positive().max(max), z.null()]).default(null);

/** Validates a specification before it becomes a new specification version. */
export const specSchema: z.ZodType<DocumentSpec> = z.object({
  page: z.object({ size: z.enum(["A4", "Letter"]), marginsMm: z.object({ top: mm, bottom: mm, left: mm, right: mm }) }),
  font: z.object({ family: z.string().trim().min(2).max(60).regex(/^[A-Za-z0-9 -]+$/, "Use a plain font name"), sizePt: z.coerce.number().min(8).max(16) }),
  headingFont: z.string().trim().min(2).max(60).regex(/^[A-Za-z0-9 -]+$/),
  lineSpacing: z.coerce.number().min(1).max(3),
  paragraph: z.object({ spaceBeforePt: z.coerce.number().min(0).max(36), spaceAfterPt: z.coerce.number().min(0).max(36), firstLineIndentMm: z.coerce.number().min(0).max(25) }),
  headingNumbering: z.boolean(),
  pageNumbers: z.object({ position: z.enum(["bottom-center", "bottom-right", "top-right", "none"]), prelims: z.enum(["roman", "none"]) }),
  header: z.string().max(200),
  footer: z.string().max(200),
  citationStyle: z.enum(["apa7", "harvard", "mla", "chicago", "ieee", "vancouver"]),
  limits: z.object({ minWords: nullableInt(500_000), maxWords: nullableInt(500_000), maxPages: nullableInt(2000), abstractMaxWords: nullableInt(5000) }),
  titlePage: z.boolean(),
  captions: z.object({ table: z.enum(["above", "below"]), figure: z.enum(["above", "below"]) }),
  sections: z
    .array(
      z.object({
        key: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
        title: z.string().trim().min(1).max(200),
        kind: z.enum(["title", "front", "toc", "body", "references", "appendix"]),
        required: z.boolean(),
        wordLimit: z.number().int().positive().nullable().optional(),
        guidance: z.string().max(1000).optional(),
      }),
    )
    .max(60),
}) as unknown as z.ZodType<DocumentSpec>;

export const PAGE_MM = { A4: { w: 210, h: 297 }, Letter: { w: 215.9, h: 279.4 } } as const;

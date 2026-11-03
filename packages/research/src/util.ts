import { AppError } from "@researchmate/shared";
import { z } from "zod";

export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

export const optionalInt = (max: number) =>
  z
    .union([z.number(), z.string()])
    .optional()
    .nullable()
    .transform((v, ctx) => {
      if (v === undefined || v === null || v === "") return null;
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isInteger(n) || n < 0 || n > max) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must be a whole number between 0 and ${max}` });
        return z.NEVER;
      }
      return n;
    });

export const optionalDate = z
  .string()
  .optional()
  .nullable()
  .transform((v, ctx) => {
    if (!v) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a valid date" });
      return z.NEVER;
    }
    return v;
  });


export function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const first = r.error.issues[0]!;
    const field = first.path.join(".");
    throw new AppError("VALIDATION", field && !first.message.includes(" ") ? `${field}: ${first.message}` : first.message, {
      fields: Object.fromEntries(r.error.issues.map((i) => [i.path.join("."), i.message])),
    });
  }
  return r.data;
}


export const requiredText = (label: string, max: number) => z.string().trim().min(1, `${label} is required`).max(max, `${label} must be at most ${max} characters`);

export const uuidSchema = z.string().uuid("Invalid id");

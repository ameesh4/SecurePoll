import type { z } from "zod";
import { BadRequestError } from "../../lib/errors";

function formatIssues(error: z.ZodError): { fieldErrors: Record<string, string[]> } {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return { fieldErrors };
}

/**
 * Parsed explicitly inside handlers rather than as middleware, so the handler gets the
 * inferred type of the schema instead of a widened `any` off the request.
 */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new BadRequestError("Validation failed", formatIssues(result.error));
  }
  return result.data;
}

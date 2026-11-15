import type { z } from 'zod';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Thrown when access cannot be verified (authority unreachable). Callers must deny. */
export class AclUnavailableError extends Error {
  constructor() {
    super('acl_unavailable');
  }
}

// One response for "does not exist" and "exists but you may not read it",
// so private repositories cannot be discovered by probing.
export const repoNotFound = () => new HttpError(404, 'not_found', 'Repository not found');

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    // Name the invalid fields only; never echo submitted values.
    const fields = [...new Set(r.error.issues.map((i) => i.path.join('.') || 'body'))].join(', ');
    throw new HttpError(400, 'invalid_request', `Invalid request: ${fields}`);
  }
  return r.data;
}

import { z } from 'zod';

// Identifiers are restricted to a safe character set: no operators, dots or path separators.
export const repoIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const labelSchema = z.string().min(1).max(64).regex(/^[^$\u0000]+$/);

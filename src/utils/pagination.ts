export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function pageMeta(page: number, limit: number, total: number): PageMeta {
  return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

export const skipFor = (page: number, limit: number) => (page - 1) * limit;

/** Escapes user input for safe use inside a RegExp. */
export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

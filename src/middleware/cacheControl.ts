import type { RequestHandler } from 'express';

/**
 * Short public caching for anonymous, location-keyed reads (nearby farms, listings).
 * The URL already contains the coordinates and filters, so browsers and CDNs can reuse a
 * response for a few seconds; stock changes still show up within `maxAge` seconds.
 * Responses to signed-in requests are marked private so shared caches never store them.
 */
export const publicCache =
  (maxAge = 30, staleWhileRevalidate = 60): RequestHandler =>
  (req, res, next) => {
    const signedIn = Boolean(req.headers.authorization || req.cookies?.khetse_token);
    res.set(
      'Cache-Control',
      signedIn ? 'private, no-store' : `public, max-age=${maxAge}, stale-while-revalidate=${staleWhileRevalidate}`,
    );
    next();
  };

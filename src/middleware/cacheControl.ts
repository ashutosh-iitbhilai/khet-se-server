import type { RequestHandler } from 'express';

/**
 * Cache headers for public, location-keyed reads (nearby farms, listings, profiles).
 *
 * These lists change whenever stock, prices or orders change, so browsers must not show a
 * stored copy without checking first: `no-cache` makes them revalidate every time, and the
 * automatic ETag turns an unchanged response into a cheap `304 Not Modified`. The API's own
 * short-lived recommendation cache (cleared on every farm, listing or stock change) keeps the
 * work per request low. Signed-in responses are never stored by shared caches.
 *
 * The arguments are kept for call-site compatibility; a CDN can still be given a short
 * `s-maxage` here if one is put in front of the API later.
 */
export const publicCache =
  (_maxAge = 0, _staleWhileRevalidate = 0): RequestHandler =>
  (req, res, next) => {
    const signedIn = Boolean(req.headers.authorization || req.cookies?.khetse_token);
    res.set('Cache-Control', signedIn ? 'private, no-cache' : 'public, no-cache');
    next();
  };

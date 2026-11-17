import type { RequestHandler } from 'express';
import { ApiError } from '../utils/ApiError';
import { verifyToken } from '../utils/jwt';
import type { UserRole } from '../models/User';

export const AUTH_COOKIE = 'khetse_token';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: { userId: string; role: UserRole };
    }
  }
}

function extractToken(req: Parameters<RequestHandler>[0]): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return req.cookies?.[AUTH_COOKIE];
}

/** Requires a valid JWT (httpOnly cookie or `Authorization: Bearer`). */
export const authenticate: RequestHandler = (req, _res, next) => {
  const token = extractToken(req);
  if (!token) return next(ApiError.unauthorized());
  try {
    const payload = verifyToken(token);
    req.auth = { userId: payload.sub, role: payload.role };
    next();
  } catch {
    next(new ApiError(401, 'TOKEN_INVALID', 'Your session has expired. Please log in again.'));
  }
};

/** Attaches auth if a valid token is present, but never rejects. */
export const optionalAuth: RequestHandler = (req, _res, next) => {
  const token = extractToken(req);
  if (token) {
    try {
      const payload = verifyToken(token);
      req.auth = { userId: payload.sub, role: payload.role };
    } catch {
      /* ignore invalid token on public routes */
    }
  }
  next();
};

/** Restricts a route to the given roles. Use after `authenticate`. */
export const authorize =
  (...roles: UserRole[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.auth) return next(ApiError.unauthorized());
    if (!roles.includes(req.auth.role)) return next(ApiError.forbidden());
    next();
  };

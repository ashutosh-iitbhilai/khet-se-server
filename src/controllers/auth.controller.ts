import type { CookieOptions, Request, Response } from 'express';
import * as authService from '../services/auth.service';
import * as sessions from '../services/session.service';
import { AUTH_COOKIE, REFRESH_COOKIE } from '../middleware/auth';
import { env } from '../config/env';
import { durationToMs } from '../utils/jwt';

const base: CookieOptions = {
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: env.COOKIE_SAMESITE,
};
const accessCookie: CookieOptions = { ...base, path: '/' };
// The refresh token is only ever sent to the auth endpoints, never to the rest of the API.
const refreshCookie: CookieOptions = { ...base, path: '/api/auth' };

const meta = (req: Request): sessions.SessionMeta => ({ userAgent: req.get('user-agent'), ip: req.ip });

function sendAuth(res: Response, status: number, result: sessions.IssuedTokens) {
  res.cookie(AUTH_COOKIE, result.accessToken, { ...accessCookie, maxAge: durationToMs(env.ACCESS_TOKEN_TTL) });
  res.cookie(REFRESH_COOKIE, result.refreshToken, { ...refreshCookie, expires: result.refreshExpiresAt });
  // The short-lived access token is also returned for non-browser clients (Bearer auth).
  // The refresh token stays in its httpOnly cookie, out of reach of page scripts.
  res.status(status).json({ success: true, data: { user: result.user, token: result.accessToken } });
}

function clearAuth(res: Response) {
  res.clearCookie(AUTH_COOKIE, accessCookie);
  res.clearCookie(REFRESH_COOKIE, refreshCookie);
}

export async function register(req: Request, res: Response) {
  sendAuth(res, 201, await authService.register(req.body, meta(req)));
}

export async function login(req: Request, res: Response) {
  sendAuth(res, 200, await authService.login(req.body, meta(req)));
}

/** Exchanges the refresh cookie for a new access token and a new (rotated) refresh token. */
export async function refresh(req: Request, res: Response) {
  try {
    sendAuth(res, 200, await sessions.rotate(req.cookies?.[REFRESH_COOKIE], meta(req)));
  } catch (err) {
    clearAuth(res);
    throw err;
  }
}

export async function logout(req: Request, res: Response) {
  await sessions.endSession(req.cookies?.[REFRESH_COOKIE]);
  clearAuth(res);
  res.status(200).json({ success: true, data: null });
}

/** Signs this user out on every device. */
export async function logoutAll(req: Request, res: Response) {
  const ended = await sessions.endAllSessions(req.auth!.userId);
  clearAuth(res);
  res.status(200).json({ success: true, data: { sessionsEnded: ended } });
}

export async function me(req: Request, res: Response) {
  const user = await authService.getById(req.auth!.userId);
  res.json({ success: true, data: { user } });
}

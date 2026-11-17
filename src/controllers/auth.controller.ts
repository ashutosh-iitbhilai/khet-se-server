import type { CookieOptions, Request, Response } from 'express';
import * as authService from '../services/auth.service';
import { AUTH_COOKIE } from '../middleware/auth';
import { env } from '../config/env';
import { durationToMs } from '../utils/jwt';

const cookieOptions: CookieOptions = {
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: env.COOKIE_SAMESITE,
  path: '/',
};

function sendAuth(res: Response, status: number, result: authService.AuthResult) {
  res.cookie(AUTH_COOKIE, result.token, { ...cookieOptions, maxAge: durationToMs(env.JWT_EXPIRES_IN) });
  // Token is also returned so non-browser clients (mobile app, scripts) can use Bearer auth.
  res.status(status).json({ success: true, data: { user: result.user, token: result.token } });
}

export async function register(req: Request, res: Response) {
  sendAuth(res, 201, await authService.register(req.body));
}

export async function login(req: Request, res: Response) {
  sendAuth(res, 200, await authService.login(req.body));
}

export async function logout(_req: Request, res: Response) {
  res.clearCookie(AUTH_COOKIE, cookieOptions);
  res.status(200).json({ success: true, data: null });
}

export async function me(req: Request, res: Response) {
  const user = await authService.getById(req.auth!.userId);
  res.json({ success: true, data: { user } });
}

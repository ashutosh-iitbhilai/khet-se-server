import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../config/env';
import type { UserRole } from '../models/User';

export interface JwtPayload {
  sub: string; // user id
  role: UserRole;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as SignOptions['expiresIn'],
  });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, env.JWT_SECRET) as JwtPayload;
}

/** Parses durations like "7d", "12h", "30m" into milliseconds (for cookie maxAge). */
export function durationToMs(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (!match) return 7 * 24 * 60 * 60 * 1000;
  const n = Number(match[1]);
  const unit = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[match[2] as 's' | 'm' | 'h' | 'd'];
  return n * unit;
}

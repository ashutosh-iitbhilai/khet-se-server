/**
 * Creates (or promotes) an admin account. Admins can't sign up through the app.
 *
 *   ADMIN_PHONE=9876543210 ADMIN_NAME="Asha Rao" ADMIN_PASSWORD='a long passphrase' npm run admin:create
 *   (optional ADMIN_EMAIL=ops@khetse.in)
 *
 * In production: npm run admin:create:prod with the same variables. The password must be at
 * least 12 characters. An existing account with that mobile number is promoted to admin and
 * its password reset; all its sessions are ended.
 */
import bcrypt from 'bcryptjs';
import { connectDatabase, disconnectDatabase } from '../config/db';
import { User } from '../models/User';
import { endAllSessions } from '../services/session.service';
import { normalizePhone } from '../validators/common';

async function main() {
  const phone = normalizePhone(process.env.ADMIN_PHONE ?? '');
  const name = (process.env.ADMIN_NAME ?? '').trim();
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase() || undefined;
  const password = process.env.ADMIN_PASSWORD ?? '';
  if (!/^[6-9]\d{9}$/.test(phone)) throw new Error('Set ADMIN_PHONE to a 10-digit Indian mobile number');
  if (name.length < 2) throw new Error('Set ADMIN_NAME');
  if (password.length < 12) throw new Error('Set ADMIN_PASSWORD (at least 12 characters)');

  await connectDatabase();
  const passwordHash = await bcrypt.hash(password, 12);
  const existing = await User.findOne({ phone });
  if (existing) {
    existing.set({ role: 'admin', status: 'active', name, passwordHash, ...(email ? { email } : {}) });
    await existing.save();
    await endAllSessions(existing._id, 'logout_all');
    console.log(`Promoted ${name} (${phone}) to admin.`);
  } else {
    await User.create({ name, phone, email, role: 'admin', status: 'active', passwordHash });
    console.log(`Created admin ${name} (${phone}). Log in with the mobile number at /login.`);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(disconnectDatabase);

import bcrypt from 'bcryptjs';
import { User, type UserDocument } from '../models/User';
import { ApiError } from '../utils/ApiError';
import { signToken } from '../utils/jwt';
import { ensureFarmerForUser } from './farmer.service';
import type { LoginInput, RegisterInput } from '../validators/auth.validator';

const BCRYPT_ROUNDS = 12;

export interface AuthResult {
  user: UserDocument;
  token: string;
}

function issue(user: UserDocument): AuthResult {
  return { user, token: signToken({ sub: user.id, role: user.role }) };
}

export async function register(input: RegisterInput): Promise<AuthResult> {
  const existing = await User.exists({ email: input.email });
  if (existing) throw ApiError.conflict('An account with this email already exists');

  if (input.phone && (await User.exists({ phone: input.phone }))) {
    throw ApiError.conflict('An account with this mobile number already exists');
  }

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  const user = await User.create({
    name: input.name,
    email: input.email,
    phone: input.phone,
    passwordHash,
    role: input.role,
  });

  // Farmers get an (empty) profile immediately so the dashboard can guide onboarding.
  if (user.role === 'farmer') await ensureFarmerForUser(user._id);

  return issue(user);
}

export async function login(input: LoginInput): Promise<AuthResult> {
  const user = await User.findOne({ email: input.email }).select('+passwordHash');

  // Same message for unknown email and wrong password — don't leak which accounts exist.
  if (!user || !(await user.comparePassword(input.password))) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password');
  }
  if (user.status !== 'active') {
    throw ApiError.forbidden('This account has been suspended. Please contact support.');
  }

  user.lastLoginAt = new Date();
  await user.save();
  return issue(user);
}

export async function getById(id: string): Promise<UserDocument> {
  const user = await User.findById(id);
  if (!user) throw ApiError.notFound('User not found');
  return user;
}

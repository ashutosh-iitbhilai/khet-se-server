import { User } from '../models/User';
import { ApiError } from '../utils/ApiError';
import { endAllSessions } from './session.service';
import type { UpdateMeInput } from '../validators/user.validator';

export async function updateMe(userId: string, input: UpdateMeInput) {
  const user = await User.findById(userId);
  if (!user) throw ApiError.notFound('User not found');

  if (input.phone && input.phone !== user.phone && (await User.exists({ phone: input.phone, _id: { $ne: user._id } }))) {
    throw ApiError.conflict('This mobile number is already used by another account', [
      { field: 'phone', message: 'Already in use' },
    ]);
  }

  if (input.name !== undefined) user.name = input.name;
  if (input.phone !== undefined) user.phone = input.phone || undefined;
  await user.save();
  return user;
}

/**
 * Suspends or re-activates an account. Suspension ends every session immediately, so the
 * user is locked out within ACCESS_TOKEN_TTL (their current access token's remaining life).
 */
export async function setUserStatus(userId: string, status: 'active' | 'suspended') {
  const user = await User.findByIdAndUpdate(userId, { $set: { status } }, { new: true });
  if (!user) throw ApiError.notFound('User not found');
  if (status === 'suspended') await endAllSessions(user._id, 'suspended');
  return user;
}

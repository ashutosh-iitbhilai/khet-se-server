import { User } from '../models/User';
import { ApiError } from '../utils/ApiError';
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

import crypto from 'crypto';
import { env } from '../config/env';
import { ApiError } from '../utils/ApiError';

export const uploadsEnabled = () =>
  Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);

const FOLDERS = { farm: 'khet-se/farms', product: 'khet-se/products', certificate: 'khet-se/certificates' } as const;
export type UploadKind = keyof typeof FOLDERS;

/**
 * Returns parameters for a signed *direct* browser → Cloudinary upload.
 * The file never passes through our API, and the secret never leaves the server.
 * https://cloudinary.com/documentation/upload_images#generating_authentication_signatures
 */
export function signUpload(kind: UploadKind, userId: string) {
  if (!uploadsEnabled()) {
    throw new ApiError(503, 'UPLOADS_DISABLED', 'Photo uploads are not configured on this server. Paste an image link instead.');
  }

  const timestamp = Math.round(Date.now() / 1000);
  const params: Record<string, string | number> = {
    folder: `${FOLDERS[kind]}/${userId}`,
    timestamp,
    // Resize on upload so oversized phone photos never reach storage.
    transformation: 'c_limit,w_2000,h_2000,q_auto:good',
    // Signed, so the browser can't change them: Cloudinary rejects anything that isn't one of these.
    allowed_formats: 'jpg,jpeg,png,webp',
  };

  const toSign = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  const signature = crypto.createHash('sha1').update(toSign + env.CLOUDINARY_API_SECRET).digest('hex');

  return {
    uploadUrl: `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`,
    apiKey: env.CLOUDINARY_API_KEY,
    signature,
    ...params,
  };
}

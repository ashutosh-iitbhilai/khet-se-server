import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { jsonTransform } from './common';

export const VERIFICATION_STATUSES = ['unsubmitted', 'pending', 'verified', 'rejected'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const FARMING_PRACTICES = [
  'certified-organic',
  'natural-farming',
  'no-chemical-pesticides',
  'drip-irrigation',
  'vermicompost',
  'crop-rotation',
] as const;

export interface IFarmer {
  user: Types.ObjectId;
  bio?: string;
  experienceYears?: number;
  languages: string[];
  practices: (typeof FARMING_PRACTICES)[number][];
  /** Identity / profile verification by an admin. */
  profileStatus: VerificationStatus;
  /** Organic certification claim — verified separately from the profile. */
  organicCertification: {
    status: VerificationStatus;
    certificateNumber?: string;
    issuer?: string; // e.g. PGS-India, NPOP accredited body
    documentUrl?: string;
    validUntil?: Date;
    reviewNote?: string;
  };
  ratingAvg: number;
  ratingCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export type FarmerDocument = HydratedDocument<IFarmer>;

const farmerSchema = new Schema<IFarmer>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    bio: { type: String, trim: true, maxlength: 1000 },
    experienceYears: { type: Number, min: 0, max: 80 },
    languages: { type: [String], default: [] },
    practices: { type: [String], enum: FARMING_PRACTICES, default: [] },
    profileStatus: { type: String, enum: VERIFICATION_STATUSES, default: 'pending', index: true },
    organicCertification: {
      status: { type: String, enum: VERIFICATION_STATUSES, default: 'unsubmitted' },
      certificateNumber: { type: String, trim: true, maxlength: 80 },
      issuer: { type: String, trim: true, maxlength: 120 },
      documentUrl: { type: String, trim: true },
      validUntil: Date,
      reviewNote: { type: String, trim: true, maxlength: 500 },
    },
    ratingAvg: { type: Number, default: 0, min: 0, max: 5 },
    ratingCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true, toJSON: jsonTransform },
);

export const Farmer = model<IFarmer>('Farmer', farmerSchema);

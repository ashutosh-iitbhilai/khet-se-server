/**
 * Public shapes for listings, farms and farmers. Every public endpoint returns these,
 * so the web client renders one card type no matter where the data came from.
 * Private fields (exact address line, reserved stock, phone) never leave the server.
 */
import type { Types } from 'mongoose';

type Id = Types.ObjectId | string;

export interface FarmerSource {
  _id: Id;
  user?: { name: string } | null;
  ratingAvg: number;
  ratingCount: number;
  profileStatus: string;
  experienceYears?: number;
  organicCertification?: { status?: string; issuer?: string };
}

export function publicFarmerSummary(f: FarmerSource) {
  return {
    id: String(f._id),
    name: f.user?.name ?? 'Farmer',
    ratingAvg: f.ratingAvg,
    ratingCount: f.ratingCount,
    organicVerified: f.organicCertification?.status === 'verified',
    profileVerified: f.profileStatus === 'verified',
    experienceYears: f.experienceYears,
  };
}

export interface FarmSource {
  _id: Id;
  name: string;
  description?: string;
  images?: string[];
  address?: { village?: string; district?: string; state?: string };
  city?: string;
  location: { coordinates: [number, number] };
  areaAcres?: number;
  deliveryRadiusKm: number;
  deliveryAvailable?: boolean;
  pickupAvailable: boolean;
  distance?: number; // metres from $geoNear
}

export function publicFarm(f: FarmSource) {
  return {
    id: String(f._id),
    name: f.name,
    description: f.description,
    images: f.images ?? [],
    village: f.address?.village,
    district: f.address?.district,
    state: f.address?.state,
    city: f.city,
    location: { lng: f.location.coordinates[0], lat: f.location.coordinates[1] },
    areaAcres: f.areaAcres,
    deliveryRadiusKm: f.deliveryRadiusKm,
    deliveryAvailable: f.deliveryAvailable ?? true,
    pickupAvailable: f.pickupAvailable,
    distanceKm: f.distance != null ? Math.round(f.distance / 100) / 10 : null,
  };
}

export interface ListingSource {
  _id: Id;
  product: { _id: Id; name: string; localName?: string; slug: string; image: string; type: 'fresh' | 'dry'; category: string; description?: string };
  price: number;
  unit: string;
  packSizeGrams?: number;
  quantityAvailable: number;
  minOrderQty: number;
  harvestDate?: Date;
  processedDate?: Date;
  expiryDate?: Date;
  packaging?: string;
  description?: string;
  images?: string[];
  organicClaim: boolean;
}

export function publicListing(
  l: ListingSource,
  farm: { id: string; name: string; village?: string; district?: string; pickupAvailable: boolean },
  farmer: ReturnType<typeof publicFarmerSummary>,
  distanceKm: number | null,
) {
  return {
    id: String(l._id),
    product: {
      id: String(l.product._id),
      name: l.product.name,
      localName: l.product.localName,
      slug: l.product.slug,
      image: l.product.image,
      type: l.product.type,
      category: l.product.category,
    },
    price: l.price,
    unit: l.unit,
    packSizeGrams: l.packSizeGrams,
    quantityAvailable: l.quantityAvailable,
    minOrderQty: l.minOrderQty,
    harvestDate: l.harvestDate,
    processedDate: l.processedDate,
    expiryDate: l.expiryDate,
    packaging: l.packaging,
    description: l.description,
    images: l.images ?? [],
    organicClaim: l.organicClaim,
    farm,
    farmer,
    distanceKm,
  };
}

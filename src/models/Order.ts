import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { jsonTransform, pointSchema, type GeoPoint } from './common';

/**
 * One customer order can include several farms. Each farm's part is a "group" that the
 * farmer accepts, packs and delivers independently. Item prices are snapshots taken at
 * checkout, so later price changes never alter an order.
 */

export const GROUP_STATUSES = ['pending', 'accepted', 'packed', 'out_for_delivery', 'delivered', 'rejected', 'cancelled'] as const;
export type GroupStatus = (typeof GROUP_STATUSES)[number];
export const CLOSED_GROUP_STATUSES: GroupStatus[] = ['delivered', 'rejected', 'cancelled'];

export const ORDER_STATUSES = ['placed', 'in_progress', 'completed', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const PAYMENT_METHODS = ['cod', 'online'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * cod_pending   — cash on delivery, not yet collected
 * pending       — online payment not completed yet (stock held until reservationExpiresAt)
 * paid          — fully paid / collected
 * refund_pending— paid, but some groups were rejected/cancelled; refundDue is owed
 * cancelled     — nothing to pay (all groups cancelled before payment)
 */
export const PAYMENT_STATUSES = ['cod_pending', 'pending', 'paid', 'refund_pending', 'cancelled'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export interface IOrderItem {
  inventory: Types.ObjectId;
  product: Types.ObjectId;
  productName: string;
  image: string;
  unit: string;
  packSizeGrams?: number;
  price: number;
  quantity: number;
  lineTotal: number;
}

export interface IStatusEvent {
  status: GroupStatus;
  at: Date;
  by: 'customer' | 'farmer' | 'system' | 'admin';
  note?: string;
}

export interface IOrderGroup {
  _id: Types.ObjectId;
  farmer: Types.ObjectId;
  farm: Types.ObjectId;
  farmName: string;
  farmerName: string;
  farmerPhone?: string;
  items: IOrderItem[];
  subtotal: number;
  deliveryFee: number;
  total: number;
  distanceKm: number;
  status: GroupStatus;
  history: IStatusEvent[];
  /** 4-digit code the customer gives the farmer on delivery. */
  handoverCode: string;
  scheduledFor?: Date;
  paymentCollected: boolean;
  cancelReason?: string;
}

export interface IOrder {
  orderNumber: string;
  customer: Types.ObjectId;
  idempotencyKey: string;
  address: {
    name: string;
    phone: string;
    line1: string;
    landmark?: string;
    city: string;
    pincode: string;
    location: GeoPoint;
  };
  groups: Types.DocumentArray<IOrderGroup & Types.Subdocument>;
  itemsTotal: number;
  deliveryTotal: number;
  grandTotal: number;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  refundDue: number;
  reservationExpiresAt?: Date | null;
  status: OrderStatus;
  createdAt: Date;
  updatedAt: Date;
}

export type OrderDocument = HydratedDocument<IOrder>;

const itemSchema = new Schema<IOrderItem>(
  {
    inventory: { type: Schema.Types.ObjectId, ref: 'Inventory', required: true },
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    productName: { type: String, required: true },
    image: { type: String, required: true },
    unit: { type: String, required: true },
    packSizeGrams: Number,
    price: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 0.01 },
    lineTotal: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const eventSchema = new Schema<IStatusEvent>(
  {
    status: { type: String, enum: GROUP_STATUSES, required: true },
    at: { type: Date, required: true },
    by: { type: String, enum: ['customer', 'farmer', 'system', 'admin'], required: true },
    note: { type: String, maxlength: 300 },
  },
  { _id: false },
);

const groupSchema = new Schema<IOrderGroup>({
  farmer: { type: Schema.Types.ObjectId, ref: 'Farmer', required: true },
  farm: { type: Schema.Types.ObjectId, ref: 'Farm', required: true },
  farmName: { type: String, required: true },
  farmerName: { type: String, required: true },
  farmerPhone: String,
  items: { type: [itemSchema], required: true },
  subtotal: { type: Number, required: true },
  deliveryFee: { type: Number, required: true },
  total: { type: Number, required: true },
  distanceKm: { type: Number, required: true },
  status: { type: String, enum: GROUP_STATUSES, default: 'pending' },
  history: { type: [eventSchema], default: [] },
  handoverCode: { type: String, required: true },
  scheduledFor: Date,
  paymentCollected: { type: Boolean, default: false },
  cancelReason: { type: String, maxlength: 300 },
});

const orderSchema = new Schema<IOrder>(
  {
    orderNumber: { type: String, required: true, unique: true },
    customer: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    idempotencyKey: { type: String, required: true },
    address: {
      name: { type: String, required: true },
      phone: { type: String, required: true },
      line1: { type: String, required: true },
      landmark: String,
      city: { type: String, required: true },
      pincode: { type: String, required: true },
      location: { type: pointSchema, required: true },
    },
    groups: { type: [groupSchema], required: true },
    itemsTotal: { type: Number, required: true },
    deliveryTotal: { type: Number, required: true },
    grandTotal: { type: Number, required: true },
    paymentMethod: { type: String, enum: PAYMENT_METHODS, required: true },
    paymentStatus: { type: String, enum: PAYMENT_STATUSES, required: true },
    refundDue: { type: Number, default: 0 },
    reservationExpiresAt: Date,
    status: { type: String, enum: ORDER_STATUSES, default: 'placed' },
  },
  { timestamps: true, toJSON: jsonTransform },
);

// Duplicate submissions (double-click, retry after timeout) map to the same order.
orderSchema.index({ customer: 1, idempotencyKey: 1 }, { unique: true });
orderSchema.index({ customer: 1, createdAt: -1 });
// Farmer queues: "my groups in status X"
orderSchema.index({ 'groups.farmer': 1, 'groups.status': 1, createdAt: -1 });
// Expiry job: unpaid online orders past their reservation window
orderSchema.index({ paymentStatus: 1, reservationExpiresAt: 1 });

export const Order = model<IOrder>('Order', orderSchema);

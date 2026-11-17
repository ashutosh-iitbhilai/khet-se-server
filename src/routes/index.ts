import { Router } from 'express';
import mongoose from 'mongoose';
import authRoutes from './auth.routes';
import farmerRoutes from './farmer.routes';
import farmRoutes from './farm.routes';
import productRoutes from './product.routes';
import inventoryRoutes from './inventory.routes';
import recommendationRoutes from './recommendation.routes';
import { addressRoutes, orderRoutes, paymentRoutes } from './order.routes';
import { geoRoutes, uploadRoutes, userRoutes } from './misc.routes';

const router = Router();

router.get('/health', (_req, res) => {
  const dbReady = mongoose.connection.readyState === 1;
  res.status(dbReady ? 200 : 503).json({
    success: dbReady,
    data: { status: dbReady ? 'ok' : 'degraded', db: dbReady ? 'connected' : 'disconnected', uptime: process.uptime() },
  });
});

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/farmers', farmerRoutes);
router.use('/farms', farmRoutes);
router.use('/products', productRoutes);
router.use('/inventory', inventoryRoutes);
router.use('/recommendations', recommendationRoutes);
router.use('/addresses', addressRoutes);
router.use('/orders', orderRoutes);
router.use('/payments', paymentRoutes);
router.use('/geo', geoRoutes);
router.use('/uploads', uploadRoutes);
// Later: reviews, admin

export default router;

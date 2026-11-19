import { Router } from 'express';
import * as ctrl from '../controllers/auth.controller';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth';
import { authLimiter, resetLimiter } from '../middleware/rateLimit';
import { forgotPasswordSchema, googleStartSchema, loginSchema, registerSchema, resetPasswordSchema } from '../validators/auth.validator';

const router = Router();

router.post('/register', authLimiter, validate(registerSchema), asyncHandler(ctrl.register));
router.post('/login', authLimiter, validate(loginSchema), asyncHandler(ctrl.login));
router.post('/refresh', authLimiter, asyncHandler(ctrl.refresh));
router.post('/logout', asyncHandler(ctrl.logout));
router.post('/logout-all', authenticate, asyncHandler(ctrl.logoutAll));
router.get('/me', authenticate, asyncHandler(ctrl.me));

router.get('/providers', ctrl.providers);
router.post('/forgot-password', resetLimiter, validate(forgotPasswordSchema), asyncHandler(ctrl.forgotPassword));
router.post('/reset-password', authLimiter, validate(resetPasswordSchema), asyncHandler(ctrl.resetPassword));
router.get('/google', authLimiter, validate(googleStartSchema), ctrl.googleStart);
router.get('/google/callback', authLimiter, asyncHandler(ctrl.googleCallback));

export default router;

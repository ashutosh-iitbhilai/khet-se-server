import { Router } from 'express';
import * as ctrl from '../controllers/auth.controller';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth';
import { authLimiter } from '../middleware/rateLimit';
import { loginSchema, registerSchema } from '../validators/auth.validator';

const router = Router();

router.post('/register', authLimiter, validate(registerSchema), asyncHandler(ctrl.register));
router.post('/login', authLimiter, validate(loginSchema), asyncHandler(ctrl.login));
router.post('/logout', asyncHandler(ctrl.logout));
router.get('/me', authenticate, asyncHandler(ctrl.me));

export default router;

import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { authenticate } from '../middleware/auth.js';
import {
  completeMockCheckout,
  createCheckout,
  createModuleCheckout,
  getOrderForUser,
  getPaymentPublicConfig,
  getPaymobReturnUrl,
  getKashierReturnUrl,
  handlePaymobReturn,
  handlePaymobWebhook,
  handleKashierReturn,
  handleKashierWebhook,
  isCheckoutPlanId,
  isPaymentEnabled,
} from '../services/payment/paymentService.js';

const router = Router();

router.get('/config', (_req, res) => {
  res.json(getPaymentPublicConfig());
});

router.get('/setup', authenticate, (_req, res) => {
  res.json({
    ...getPaymentPublicConfig(),
    returnUrl: getPaymobReturnUrl(),
    kashierReturnUrl: getKashierReturnUrl(),
  });
});

router.post(
  '/checkout',
  authenticate,
  [body('planId').isString().notEmpty()],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    if (!isPaymentEnabled()) {
      return res.status(503).json({ error: 'Payment gateway is not configured yet' });
    }

    const planId = String(req.body.planId);
    if (!isCheckoutPlanId(planId)) {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    try {
      const checkout = await createCheckout(req.user!.id, planId);
      res.json(checkout);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'CHECKOUT_FAILED';
      if (message === 'PAYMOB_NOT_CONFIGURED') {
        return res.status(503).json({ error: 'PAYMOB_NOT_CONFIGURED' });
      }
      if (message === 'KASHIER_NOT_CONFIGURED') {
        return res.status(503).json({ error: 'KASHIER_NOT_CONFIGURED' });
      }
      console.error('[payments/checkout]', err);
      return res.status(500).json({ error: 'Could not start checkout' });
    }
  },
);

router.post(
  '/checkout-module',
  authenticate,
  [body('termId').isString().notEmpty(), body('moduleId').isString().notEmpty()],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    if (!isPaymentEnabled()) {
      return res.status(503).json({ error: 'Payment gateway is not configured yet' });
    }

    const termId = String(req.body.termId);
    const moduleId = String(req.body.moduleId);

    try {
      const checkout = await createModuleCheckout(req.user!.id, termId, moduleId);
      res.json(checkout);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'CHECKOUT_FAILED';
      if (message === 'ALREADY_OWNED') {
        return res.status(409).json({ error: 'You already own this module' });
      }
      if (message === 'INVALID_MODULE') {
        return res.status(400).json({ error: 'Invalid module' });
      }
      if (message === 'PAYMOB_NOT_CONFIGURED') {
        return res.status(503).json({ error: 'PAYMOB_NOT_CONFIGURED' });
      }
      if (message === 'KASHIER_NOT_CONFIGURED') {
        return res.status(503).json({ error: 'KASHIER_NOT_CONFIGURED' });
      }
      console.error('[payments/checkout-module]', err);
      return res.status(500).json({ error: 'Could not start checkout' });
    }
  },
);

router.get('/orders/:merchantOrderId', authenticate, async (req: Request, res: Response) => {
  const merchantOrderId = String(req.params.merchantOrderId);
  const order = await getOrderForUser(merchantOrderId, req.user!.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json({ order });
});

router.post('/mock/complete', authenticate, async (req: Request, res: Response) => {
  const merchantOrderId = String(req.body.merchantOrderId || '');
  if (!merchantOrderId) return res.status(400).json({ error: 'Missing order' });

  try {
    await completeMockCheckout(merchantOrderId, req.user!.id);
    res.json({ success: true });
  } catch (err) {
    console.error('[payments/mock/complete]', err);
    res.status(400).json({ error: 'Could not complete mock payment' });
  }
});

router.get('/return/paymob', async (req: Request, res: Response) => {
  const query = Object.fromEntries(
    Object.entries(req.query).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]),
  ) as Record<string, string | undefined>;

  try {
    const result = await handlePaymobReturn(query);
    res.redirect(result.redirect);
  } catch (err) {
    console.error('[payments/return/paymob]', err);
    res.redirect(`${process.env.CLIENT_URL || 'http://localhost:5173'}/student/payment/failed`);
  }
});

router.post('/webhook/paymob', async (req: Request, res: Response) => {
  try {
    const result = await handlePaymobWebhook(req.body);
    if (!result.ok) {
      return res.status(400).json({ error: result.reason || 'invalid' });
    }
    res.json({ received: true, status: result.status });
  } catch (err) {
    console.error('[payments/webhook/paymob]', err);
    res.status(500).json({ error: 'webhook failed' });
  }
});

router.get('/return/kashier', async (req: Request, res: Response) => {
  const query = Object.fromEntries(
    Object.entries(req.query).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]),
  ) as Record<string, string | undefined>;

  try {
    const result = await handleKashierReturn(query);
    res.redirect(result.redirect);
  } catch (err) {
    console.error('[payments/return/kashier]', err);
    res.redirect(`${process.env.CLIENT_URL || 'http://localhost:5173'}/student/payment/failed`);
  }
});

router.post('/webhook/kashier', async (req: Request, res: Response) => {
  try {
    const result = await handleKashierWebhook(req.body);
    if (!result.ok) {
      return res.status(400).json({ error: result.reason || 'invalid' });
    }
    res.json({ received: true, status: result.status });
  } catch (err) {
    console.error('[payments/webhook/kashier]', err);
    res.status(500).json({ error: 'webhook failed' });
  }
});

export default router;

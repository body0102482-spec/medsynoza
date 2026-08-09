import crypto from 'crypto';

const KASHIER_HOSTED_BASE = 'https://checkout.kashier.io';

function kashierApiBase(): string {
  const mode = (process.env.KASHIER_MODE || 'live').toLowerCase();
  return `https://${mode === 'test' ? 'test-' : ''}api.kashier.io`;
}

export interface KashierBillingData {
  email: string;
  firstName: string;
  lastName: string;
  phone?: string | null;
}

export function isKashierConfigured(): boolean {
  return !!(
    process.env.KASHIER_MID &&
    process.env.KASHIER_API_KEY &&
    process.env.KASHIER_SECRET_KEY
  );
}

export function isKashierTestMode(): boolean {
  return (process.env.KASHIER_MODE || 'live').toLowerCase() === 'test';
}

/**
 * Kashier signed-hash used for the hosted checkout page:
 * path = "/?payment={mid}.{orderId}.{amount}.{currency}" signed with the API key.
 */
export function generateKashierHash(params: {
  mid: string;
  orderId: string;
  amount: string;
  currency: string;
}): string {
  const secret = process.env.KASHIER_API_KEY || '';
  const path = `/?payment=${params.mid}.${params.orderId}.${params.amount}.${params.currency}`;
  return crypto.createHmac('sha256', secret).update(path).digest('hex');
}

/**
 * Builds the Kashier hosted checkout (PaymentUI) URL that can be opened in an
 * iframe or as a redirect.
 */
export function createKashierCheckoutUrl(params: {
  merchantOrderId: string;
  amountEgp: number;
  merchantRedirect: string;
  serverWebhook: string;
  display?: 'en' | 'ar';
}): string {
  const mid = process.env.KASHIER_MID || '';
  const amount = params.amountEgp.toFixed(2);
  const currency = process.env.KASHIER_CURRENCY || 'EGP';
  const mode = isKashierTestMode() ? 'test' : 'live';
  const allowedMethods =
    process.env.KASHIER_ALLOWED_METHODS || 'card,wallet,bank_installments';

  const hash = generateKashierHash({ mid, orderId: params.merchantOrderId, amount, currency });

  const query = new URLSearchParams({
    merchantId: mid,
    orderId: params.merchantOrderId,
    amount,
    currency,
    hash,
    mode,
    display: params.display || 'en',
    merchantRedirect: params.merchantRedirect,
    serverWebhook: params.serverWebhook,
    failureRedirect: params.merchantRedirect,
    allowedMethods,
  });

  return `${KASHIER_HOSTED_BASE}/?${query.toString()}`;
}

/**
 * Verifies the signature Kashier attaches to return callbacks / webhooks.
 * The signature is HMAC-SHA256 (using the API key) of the received params
 * joined as `key=value&...` (excluding `signature` and `mode`).
 * Tries a couple of encodings/orderings to stay compatible with Kashier's
 * various integrations.
 */
export function verifyKashierSignature(
  params: Record<string, unknown>,
  receivedSignature: string,
): boolean {
  const apiKey = process.env.KASHIER_API_KEY || '';
  const candidates = buildSignatureCandidates(params);
  return candidates.some((candidate) => {
    const computed = crypto.createHmac('sha256', apiKey).update(candidate).digest('hex');
    return computed.toLowerCase() === String(receivedSignature || '').toLowerCase();
  });
}

function buildSignatureCandidates(params: Record<string, unknown>): string[] {
  const entries = Object.entries(params).filter(
    ([key]) => key !== 'signature' && key !== 'mode',
  );

  const inOrder = entries.map(([k, v]) => `${k}=${String(v ?? '')}`);
  const sorted = [...entries]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(v ?? '')}`);
  const sortedEncoded = [...entries]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v ?? ''))}`);

  return [inOrder.join('&'), sorted.join('&'), sortedEncoded.join('&')];
}

const KASHIER_SUCCESS_STATUSES = new Set(['SUCCESS', 'CAPTURED', 'PAID', 'AUTHORIZED']);

export function isKashierSuccess(status: unknown): boolean {
  const s = String(status ?? '').toUpperCase();
  return KASHIER_SUCCESS_STATUSES.has(s);
}

/**
 * Confirms a payment against Kashier's orders API using the secret key.
 * GET https://api.kashier.io/payments/orders/{merchantOrderId}
 */
export async function isKashierOrderCaptured(merchantOrderId: string): Promise<boolean> {
  if (!isKashierConfigured()) return false;
  const secretKey = process.env.KASHIER_SECRET_KEY || '';

  try {
    const res = await fetch(
      `${kashierApiBase()}/payments/orders/${encodeURIComponent(merchantOrderId)}`,
      {
        method: 'GET',
        headers: {
          Authorization: secretKey,
          'Content-Type': 'application/json',
        },
      },
    );

    if (!res.ok) return false;

    const data = (await res.json()) as {
      response?: { status?: string };
      data?: { status?: string };
      status?: string;
    };
    const status =
      data?.response?.status || data?.data?.status || data?.status || '';
    return isKashierSuccess(status);
  } catch {
    return false;
  }
}

/**
 * Extracts a flat key/value map from a webhook payload, handling both the
 * classic form-style payload and the nested `{ data: {...} }` sessions payload.
 */
export function normalizeKashierPayload(body: Record<string, unknown>): {
  params: Record<string, unknown>;
  signature: string;
} {
  let params: Record<string, unknown> = { ...body };
  let signature = String(body.signature ?? '');

  const nested = body.data as Record<string, unknown> | undefined;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const nestedCopy: Record<string, unknown> = { ...nested };
    const nestedSignature = String(nestedCopy.signature ?? '');
    delete nestedCopy.signature;
    params = { ...params, ...nestedCopy };
    if (nestedSignature) signature = nestedSignature;
  }

  return { params, signature };
}

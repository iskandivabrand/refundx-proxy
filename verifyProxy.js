// verifyProxy.js — supports both `signature` (App Proxy) and `hmac` styles
import crypto from 'crypto';

export function verifyProxy(req, res, next) {
  try {
    const secret = process.env.SHOPIFY_API_SECRET;
    if (!secret) return res.status(500).json({ error: 'missing_secret' });

    // حاول استنتاج الدومين من الكويري أو الهيدر
    const shop =
      req.query?.shop ||
      req.headers['x-shopify-shop-domain'] ||
      req.headers['x-shopify-shop'] ||
      req.headers['x-forwarded-host'];

    if (!shop) return res.status(400).json({ error: 'missing_shop' });
    req.shop = normalizeShop(shop);

    const { signature, hmac, ...rest } = req.query || {};

    // 1) طريقة App Proxy: parameter اسمه `signature` (hex)
    if (signature) {
      const sorted = new URLSearchParams(rest);
      // Shopify بتعمل HMAC على path + '?' + query (بدون signature)
      const path = req.path.startsWith('/') ? req.path : `/${req.path}`;
      const msg = `${path}?${sorted.toString()}`;

      const digest = crypto.createHmac('sha256', secret).update(msg).digest('hex');
      if (timingSafeEqual(digest, signature)) return next();
      return res.status(401).json({ error: 'bad_signature' });
    }

    // 2) طريقة `hmac` المعتادة: query-string مرتب abcedically, hex أو base64
    if (hmac) {
      const entries = Object.entries(rest)
        .filter(([k]) => k !== 'hmac' && k !== 'signature')
        .sort(([a], [b]) => a.localeCompare(b));

      const qs = entries.map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`).join('&');
      const digestHex = crypto.createHmac('sha256', secret).update(qs).digest('hex');
      const digestB64 = crypto.createHmac('sha256', secret).update(qs).digest('base64');

      if (timingSafeEqual(digestHex, hmac) || timingSafeEqual(digestB64, hmac)) return next();
      return res.status(401).json({ error: 'bad_hmac' });
    }

    // لو مفيش توقيع خالص، ارفض
    return res.status(401).json({ error: 'missing_signature' });
  } catch (e) {
    return res.status(401).json({ error: 'verify_failed', detail: String(e.message || e) });
  }
}

function normalizeShop(shop) {
  let s = String(shop).trim().toLowerCase();
  if (!s.includes('.myshopify.com') && !s.includes('.shopifypreview.com') && !s.includes('.myshopify.io')) {
    s = s.replace(/^https?:\/\//, '');
    s = s.replace(/\/.*$/, '');
    // fallback: ضيف الدومين لو ناقص
    if (!s.includes('.')) s = `${s}.myshopify.com`;
  }
  return s;
}

function timingSafeEqual(a, b) {
  try {
    const A = Buffer.from(String(a), 'utf8');
    const B = Buffer.from(String(b), 'utf8');
    if (A.length !== B.length) return false;
    return crypto.timingSafeEqual(A, B);
  } catch {
    return false;
  }
}

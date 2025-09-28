import crypto from 'crypto';

export function verifyProxy(req, res, next) {
  try {
    const { signature, ...rest } = req.query;
    if (!signature) return res.status(401).json({ error: 'no_signature' });

    // Shopify يبعت توقيع مبني على query params مرتبة
    const sorted = new URLSearchParams(Object.entries(rest).sort());
    const hmac = crypto
      .createHmac('sha256', process.env.SHOPIFY_API_SECRET)
      .update(sorted.toString(), 'utf8')
      .digest('hex');

    if (hmac !== signature) return res.status(401).json({ error: 'bad_signature' });

    // Shopify بيضيف هيدر الدومين
    const shop = req.headers['x-shopify-shop-domain'];
    if (!shop) return res.status(400).json({ error: 'missing_shop_header' });

    req.shop = shop;
    next();
  } catch (e) {
    res.status(500).json({ error: 'verify_failed', detail: e.message });
  }
}

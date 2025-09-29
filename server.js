// server.js — RefundX Proxy (ESM, Node 20: fetch مدمج)
import express from 'express';
import { verifyProxy } from './verifyProxy.js';

const app = express();
app.use(express.json({ limit: '8mb' }));

const API_VERSION = '2025-07';

/* ---------- Helpers ---------- */
async function adminRest(shop, path, qs = {}) {
  const q = new URLSearchParams(qs).toString();
  const url = `https://${shop}/admin/api/${API_VERSION}${path}${q ? `?${q}` : ''}`;
  const r = await fetch(url, { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN } });
  if (!r.ok) throw new Error(await safeText(r));
  return r.json();
}

async function adminGraphQL(shop, query, variables = {}) {
  const r = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });
  if (!r.ok) throw new Error(await safeText(r));
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  if (j.data?.userErrors?.length) throw new Error(JSON.stringify(j.data.userErrors));
  return j.data;
}

async function safeText(res) {
  try { return await res.text(); } catch { return `HTTP ${res.status}`; }
}

/* ---------- Routes ---------- */

// Health
app.get('/proxy/health', (_req, res) => res.json({ ok: true }));

// ORDER LOOKUP
// GET /proxy/order?number=123456&email=a@b.com
app.get('/proxy/order', verifyProxy, async (req, res) => {
  try {
    const { number, email } = req.query;
    if (!number || !email) return res.status(400).json({ error: 'missing_params' });

    const data = await adminRest(req.shop, '/orders.json', {
      name: `#${number}`,
      email,
      status: 'any',
      fields: 'id,currency,line_items'
    });
    const order = data?.orders?.[0];
    if (!order) return res.status(404).json({ error: 'not_found' });

    const items = await Promise.all(
      (order.line_items || []).map(async (li) => {
        let handle = '';
        if (li.product_id) {
          try {
            const p = await adminRest(req.shop, `/products/${li.product_id}.json`);
            handle = p?.product?.handle || '';
          } catch {}
        }
        return {
          title: li.name,
          productId: li.product_id ? `gid://shopify/Product/${li.product_id}` : null,
          variantId: li.variant_id ? `gid://shopify/ProductVariant/${li.variant_id}` : null,
          handle,
          quantity: li.quantity,
          sku: li.sku || '',
          available: true
        };
      })
    );

    res.set('Cache-Control', 'no-store');
    res.json({ orderId: order.id, currency: order.currency, items });
  } catch (e) {
    res.status(500).json({ error: 'server_error', detail: String(e.message || e) });
  }
});

// STOCK / VARIANTS
// GET /proxy/stock?productId=gid://shopify/Product/123
app.get('/proxy/stock', verifyProxy, async (req, res) => {
  try {
    const { productId } = req.query;
    if (!productId) return res.status(400).json({ error: 'missing_productId' });

    const q = `
      query($id:ID!){
        product(id:$id){
          variants(first:100){
            nodes{ id title availableForSale }
          }
        }
      }`;
    const data = await adminGraphQL(req.shop, q, { id: productId });
    const variants = data?.product?.variants?.nodes?.map(v => ({
      id: v.id,
      title: v.title,
      available: v.availableForSale
    })) || [];

    res.set('Cache-Control', 'no-store');
    res.json({ variants });
  } catch (e) {
    res.status(500).json({ error: 'server_error', detail: String(e.message || e) });
  }
});

// UPLOAD START (stagedUploadsCreate)
// POST /proxy/upload/start  { filename, mime, size }
app.post('/proxy/upload/start', verifyProxy, async (req, res) => {
  try {
    const { filename, mime, size } = req.body || {};
    if (!filename || !mime || !size) return res.status(400).json({ error: 'missing_params' });

    const q = `
      mutation($input:[StagedUploadInput!]!){
        stagedUploadsCreate(input:$input){
          stagedTargets{ url resourceUrl parameters{ name value } }
          userErrors{ field message }
        }
      }`;
    const input = [{ resource: 'FILE', filename, mimeType: mime, fileSize: size, httpMethod: 'POST' }];
    const data = await adminGraphQL(req.shop, q, { input });

    const t = data?.stagedUploadsCreate?.stagedTargets?.[0];
    if (!t) return res.status(500).json({ error: 'staged_failed' });

    const formData = {};
    for (const p of (t.parameters || [])) formData[p.name] = p.value;

    res.json({ method: 'POST', uploadUrl: t.url, formData, token: t.resourceUrl });
  } catch (e) {
    res.status(500).json({ error: 'server_error', detail: String(e.message || e) });
  }
});

// UPLOAD COMPLETE (fileCreate)
// POST /proxy/upload/complete  { token, filename }
app.post('/proxy/upload/complete', verifyProxy, async (req, res) => {
  try {
    const { token, filename } = req.body || {};
    if (!token || !filename) return res.status(400).json({ error: 'missing_params' });

    const q = `
      mutation($files:[FileCreateInput!]!){
        fileCreate(files:$files){
          files{ url alt }
          userErrors{ field message }
        }
      }`;
    const files = [{ alt: filename, contentType: 'FILE', originalSource: token }];
    const data = await adminGraphQL(req.shop, q, { files });

    const url = data?.fileCreate?.files?.[0]?.url;
    if (!url) return res.status(500).json({ error: 'file_create_failed' });

    res.json({ url });
  } catch (e) {
    res.status(500).json({ error: 'server_error', detail: String(e.message || e) });
  }
});

/* Local dev only */
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log('RefundX proxy up on port', PORT));
}

export default app;

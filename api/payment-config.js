// GET /api/payment-config
// Returns a checkout URL for the payment page (non-extension checkout flow).
// The payment page calls this to get the URL for the "Continue to Checkout" button.
const { cors, paddleRequest, PADDLE_API_KEY, PADDLE_ENV } = require('./_helpers');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!PADDLE_API_KEY) {
    return res.status(500).json({ error: 'PADDLE_API_KEY not configured' });
  }

  // Default to Pro pack price ID
  const priceId = req.query.priceId
    || process.env.PRICE_PRO
    || 'pri_01kkwtx0kh2skzrzjbxgmgqngd';

  try {
    const data = await paddleRequest('/transactions', {
      items: [{ price_id: priceId, quantity: 1 }],
    });

    if (data?.data?.checkout?.url) {
      return res.status(200).json({ checkoutUrl: data.data.checkout.url });
    }

    if (data?.data?.id) {
      const txnId = data.data.id;
      const checkoutDomain = PADDLE_ENV === 'live'
        ? 'https://checkout.paddle.com'
        : 'https://sandbox-checkout.paddle.com';
      return res.status(200).json({ checkoutUrl: `${checkoutDomain}/transaction/${txnId}` });
    }

    console.error('Paddle response:', JSON.stringify(data));
    return res.status(502).json({ error: 'Could not generate checkout URL' });
  } catch (err) {
    console.error('Payment-config error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

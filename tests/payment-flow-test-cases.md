# Backend Payment Config Test Cases

## Automated coverage

1. Backend `/api/payment-config` returns the configured checkout URL.
2. Backend `/api/payment-config` returns `404` when no checkout URL is configured.
3. Backend `/api/health` reports whether checkout configuration is present.

## Manual regression checks

1. Start the backend with `PAYMENT_CHECKOUT_URL` configured and confirm `/api/payment-config` responds with that exact value.
2. Start the backend without `PAYMENT_CHECKOUT_URL` and confirm `/api/payment-config` responds with `404`.
3. Confirm `/api/health` flips `checkoutConfigured` between `true` and `false` as the env var changes.

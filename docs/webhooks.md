# FluxaPay Webhook Integration Guide

This guide explains how merchants consume **off-chain webhook** notifications for payment lifecycle events. On-chain event catalogs live in [`docs/events.md`](events.md) and [`fluxapay/EVENTS.md`](../fluxapay/EVENTS.md). Webhooks are the REST-facing projection of those events for merchant backends.

---

## Overview

When a payment (or refund/dispute) transitions state, FluxaPay’s off-chain indexer delivers an HTTPS `POST` to your registered webhook URL. You should:

1. Verify the HMAC-SHA256 signature
2. Deduplicate with `payment_id` (or the event’s primary id)
3. Return `2xx` quickly; handle business logic asynchronously

---

## Event types

### Payment lifecycle

| Webhook event | Trigger | Typical on-chain source |
|---------------|---------|-------------------------|
| `payment.created` | Charge created | `PAYMENT/CREATED` |
| `payment.pending` | Awaiting on-chain confirmation | payment still `Pending` |
| `payment.confirmed` | Deposit verified | `PAYMENT/CONFIRMED` / verify |
| `payment.failed` | Expired or failed | `PAYMENT/EXPIRED` / failed status |
| `payment.settled` | Merchant settled | `PAYMENT/SETTLED` |

### Refund events (`REFUND/*`)

| Webhook event | Trigger | On-chain source |
|---------------|---------|-----------------|
| `refund.requested` | Refund filed | `REFUND/REQUESTED` |
| `refund.processed` | Refund completed | `REFUND/PROCESSED` / `COMPLETED` |
| `refund.rejected` | Refund rejected | `REFUND/REJECTED` |

### Dispute events (`DISPUTE/*`)

| Webhook event | Trigger | On-chain source |
|---------------|---------|-----------------|
| `dispute.created` | Dispute opened | `DISPUTE/CREATED` |
| `dispute.reviewed` | Moved under review | `DISPUTE/REVIEWED` |
| `dispute.resolved` | Resolution applied | `DISPUTE/RESOLVED` |
| `dispute.rejected` | Dispute rejected | `DISPUTE/REJECTED` |
| `dispute.escalated` | Deadline / escalation | `DISPUTE/ESCALATED` |
| `dispute.batch_created` | Bulk filing result | `DISPUTE/BATCH_CREATED` |

---

## Payload schema

All webhooks share a common envelope:

```json
{
  "id": "evt_01HXYZ...",
  "type": "payment.confirmed",
  "created_at": 1710000000,
  "api_version": "2024-01-01",
  "data": {
    "payment_id": "pay_abc123",
    "merchant_id": "G...",
    "amount": "10000000",
    "currency": "USDC",
    "status": "confirmed",
    "metadata": {
      "order_id": "ORD-9"
    }
  }
}
```

### Field reference

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique event delivery id (not the payment id) |
| `type` | string | Event name (see tables above) |
| `created_at` | number | Unix timestamp (seconds) |
| `api_version` | string | Payload schema version |
| `data.payment_id` | string | **Idempotency / dedup key** for payment events |
| `data.merchant_id` | string | Merchant Stellar address |
| `data.amount` | string | Amount in minor units (string to avoid JSON number precision issues) |
| `data.currency` | string | e.g. `USDC` |
| `data.status` | string | Current status snapshot |
| `data.metadata` | object\|null | Merchant metadata from create |

### Refund payload extras

```json
{
  "type": "refund.processed",
  "data": {
    "refund_id": "ref_...",
    "payment_id": "pay_...",
    "amount": "5000000",
    "status": "completed"
  }
}
```

Dedup key for refunds: prefer `refund_id`; fall back to `payment_id` + `type`.

### Dispute payload extras

```json
{
  "type": "dispute.created",
  "data": {
    "dispute_id": "dsp_...",
    "payment_id": "pay_...",
    "amount": "10000000",
    "status": "open",
    "reason": "Item not received"
  }
}
```

Dedup key for disputes: `dispute_id`.

---

## HMAC-SHA256 signature verification

Every request includes:

| Header | Description |
|--------|-------------|
| `X-FluxaPay-Signature` | Hex-encoded HMAC-SHA256 of `{timestamp}.{raw_body}` |
| `X-FluxaPay-Timestamp` | Unix seconds when the webhook was signed |
| `X-FluxaPay-Event` | Same as JSON `type` (convenience) |

### Algorithm

1. Read the **raw request body** (do not re-serialize JSON).
2. Build the signed payload: `` `${timestamp}.${rawBody}` ``
3. Compute `HMAC-SHA256(webhook_secret, signed_payload)` → hex digest.
4. Compare to `X-FluxaPay-Signature` using a **constant-time** compare.
5. Reject if `|now - timestamp| > 300` seconds (replay window).

Your webhook secret is issued in the merchant dashboard (or sandbox env). Never log the secret.

---

## Retry policy

Each webhook endpoint has its own retry policy. If your endpoint does not return HTTP `2xx`, FluxaPay retries using that endpoint’s configured policy.

### Default policy

The default policy matches the historical fixed behaviour:

| Field | Default |
|-------|---------|
| `max_retries` | `3` |
| `initial_delay_ms` | `1000` |
| `backoff_multiplier` | `2.0` |
| `max_delay_ms` | `300000` |

With the defaults, delivery attempts are spaced as follows:

| Attempt | Delay before retry |
|---------|--------------------|
| 1 (initial) | immediate |
| 2 | ~1s |
| 3 | ~2s |
| 4 (final) | ~4s |

- **Max retries:** 3 retries after the first delivery (**4 total attempts**).
- **Backoff:** exponential (base ~1s, multiplier 2.0).
- After exhaustion, the event is marked failed; you can replay from the dashboard or indexer.

### Customizing the retry policy

Update an endpoint’s policy with `PATCH /v1/webhooks/{endpoint_id}`:

```json
{
  "max_retries": 10,
  "initial_delay_ms": 1000,
  "backoff_multiplier": 2.0,
  "max_delay_ms": 300000
}
```

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `max_retries` | integer | `1`–`20` | Retries after the first delivery |
| `initial_delay_ms` | integer | `500`–`60000` | Delay before the first retry, in milliseconds |
| `backoff_multiplier` | number | `1.0`–`3.0` | Multiplier applied to the delay after each attempt |
| `max_delay_ms` | integer | `>= 1` | Upper bound on any single retry delay, in milliseconds |

Values outside these ranges are rejected with a descriptive `400` error. The delay before retry `n` is `min(initial_delay_ms * backoff_multiplier^(n-1), max_delay_ms)`.

Return `200` as soon as the event is durably queued; do heavy work out-of-band.

---

## Idempotency

Deliveries can repeat (retries, at-least-once semantics).

**Recommended dedup key:** `payment_id` for payment events (as specified for merchant integrations). For refunds/disputes use `refund_id` / `dispute_id`, or composite `event_id` (`id` field) if you process many event types in one table.

Pseudo-flow:

```
if already_processed(payment_id, type):
    return 200
process(event)
mark_processed(payment_id, type)
return 200
```

Store processed keys for at least 7 days.

---

## Mapping on-chain → webhook

| On-chain `(namespace, action)` | Webhook `type` |
|--------------------------------|----------------|
| `PAYMENT/CREATED` | `payment.created` |
| (indexer pending state) | `payment.pending` |
| `PAYMENT/CONFIRMED` | `payment.confirmed` |
| `PAYMENT/EXPIRED` / failed | `payment.failed` |
| `PAYMENT/SETTLED` | `payment.settled` |
| `REFUND/REQUESTED` | `refund.requested` |
| `REFUND/PROCESSED` | `refund.processed` |
| `REFUND/REJECTED` | `refund.rejected` |
| `DISPUTE/CREATED` | `dispute.created` |
| `DISPUTE/REVIEWED` | `dispute.reviewed` |
| `DISPUTE/RESOLVED` | `dispute.resolved` |
| `DISPUTE/REJECTED` | `dispute.rejected` |
| `DISPUTE/ESCALATED` | `dispute.escalated` |
| `DISPUTE/BATCH_CREATED` | `dispute.batch_created` |

---

## Node.js (Express) example

```javascript
const express = require("express");
const crypto = require("crypto");

const app = express();
const WEBHOOK_SECRET = process.env.FLUXAPAY_WEBHOOK_SECRET;

// Must capture raw body for HMAC
app.post(
  "/webhooks/fluxapay",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const signature = req.get("X-FluxaPay-Signature") || "";
    const timestamp = req.get("X-FluxaPay-Timestamp") || "";
    const rawBody = req.body.toString("utf8");

    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(age) || age > 300) {
      return res.status(401).send("stale timestamp");
    }

    const expected = crypto
      .createHmac("sha256", WEBHOOK_SECRET)
      .update(`${timestamp}.${rawBody}`)
      .digest("hex");

    const a = Buffer.from(signature, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).send("invalid signature");
    }

    const event = JSON.parse(rawBody);
    const dedupKey = event.data.payment_id || event.data.dispute_id || event.id;

    // TODO: skip if dedupKey already processed
    console.log("received", event.type, dedupKey);

    res.status(200).json({ received: true });
  }
);

app.listen(3000);
```

---

## Python (FastAPI) example

```python
import hashlib
import hmac
import os
import time

from fastapi import FastAPI, Header, HTTPException, Request

app = FastAPI()
WEBHOOK_SECRET = os.environ["FLUXAPAY_WEBHOOK_SECRET"].encode()


@app.post("/webhooks/fluxapay")
async def fluxapay_webhook(
    request: Request,
    x_fluxapay_signature: str = Header(...),
    x_fluxapay_timestamp: str = Header(...),
):
    raw = await request.body()
    try:
        ts = int(x_fluxapay_timestamp)
    except ValueError:
        raise HTTPException(status_code=401, detail="invalid timestamp")

    if abs(time.time() - ts) > 300:
        raise HTTPException(status_code=401, detail="stale timestamp")

    signed = f"{x_fluxapay_timestamp}.".encode() + raw
    expected = hmac.new(WEBHOOK_SECRET, signed, hashlib.sha256).hexdigest()

    if not hmac.compare_digest(expected, x_fluxapay_signature):
        raise HTTPException(status_code=401, detail="invalid signature")

    event = await request.json()
    dedup_key = (
        event.get("data", {}).get("payment_id")
        or event.get("data", {}).get("dispute_id")
        or event.get("id")
    )

    # TODO: skip if dedup_key already processed
    print("received", event.get("type"), dedup_key)

    return {"received": True}
```

---

## Testing webhooks locally

Use a tunnel (ngrok, cloudflared) to expose your local server, register the URL in the sandbox dashboard, and trigger events from the sandbox. Verify signatures with the sandbox secret before going live.

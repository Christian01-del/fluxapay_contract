/**
 * FluxaPay Indexer REST API Server
 * Exposes read-only endpoints for persisted payments, disputes, refunds, and events,
 * as well as health check, manual DLQ replay, and real-time SSE event streaming.
 */

import express, { type Request, type Response, type NextFunction } from "express";
import * as dotenv from "dotenv";
import { z } from "zod";
import { Database } from "./database";
import { requireApiKey, requireAdminApiKey } from "./auth/api-key";
import { requireApiKey, requireScope } from "./auth/api-key";
import { requireSEP10Auth } from "./auth/middleware";
import { loadSEP10AuthConfig } from "./auth/config";
import { sseManager } from "./sse";
import {
  registerWebhookRoutes,
  startDeliveryLogRetentionJob,
  WebhookStore,
  type RetentionJobHandle,
} from "./webhooks";
import { getCachedRate } from "./fx-rate-cache";

dotenv.config();

export type ReplayDLQHandler = () => Promise<{ attempted: number; succeeded: number; failed: number }>;

export interface ReplayProgressUpdate {
  processed: number;
  total: number;
  stored?: number;
  currentLedger?: number;
}

export type EventReplayHandler = (
  fromLedger: number,
  toLedger: number,
  onProgress?: (progress: ReplayProgressUpdate) => void,
) => Promise<{ processed: number; stored: number; total: number }>;

export const MAX_REPLAY_LEDGER_RANGE = 10000;

/** Issue #839: stroops use 7 decimal places for USDC amounts. */
const USDC_DECIMALS = 7;
/** Issue #839: default staleness threshold (seconds) for convert preview. */
const DEFAULT_FX_STALENESS_SECS = Number(process.env.FX_STALENESS_SECS || 300);

/** Issue #839: simple per-IP sliding window rate limiter (60 req/min). */
const FX_CONVERT_LIMIT = 60;
const FX_CONVERT_WINDOW_MS = 60_000;
const fxConvertHits = new Map<string, number[]>();

function fxConvertRateLimit(req: Request, res: Response, next: NextFunction): void {
  const ip = (req.ip || req.socket.remoteAddress || "unknown").toString();
  const now = Date.now();
  const windowStart = now - FX_CONVERT_WINDOW_MS;
  const recent = (fxConvertHits.get(ip) || []).filter((t) => t > windowStart);
  if (recent.length >= FX_CONVERT_LIMIT) {
    res.status(429).json({ error: "Rate limit exceeded: 60 requests per minute" });
    return;
  }
  recent.push(now);
  fxConvertHits.set(ip, recent);
  next();
}

function formatFixed(n: number, decimals: number): string {
  return n.toFixed(decimals);
}

// Issue #785: query schema for the filtered payments endpoint.
const isoDateString = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: "Invalid ISO-8601 date" });

const paymentsQuerySchema = z.object({
  merchant_id: z.string().min(1).max(128),
  status: z
    .string()
    .optional()
    .transform((value) =>
      value
        ? value
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : undefined,
    ),
  from: isoDateString.optional(),
  to: isoDateString.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().max(512).optional(),
});

/**
 * Decode an opaque pagination cursor of the form base64url(created_at|id).
 * Returns null when the cursor is malformed so the caller can reject it.
 */
function decodePaymentsCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const separator = decoded.lastIndexOf("|");
    if (separator <= 0) return null;
    const createdAt = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    if (!createdAt || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

function encodePaymentsCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, "utf8").toString("base64url");
}

export function createServer(
  database: Database,
  replayDlqHandler?: ReplayDLQHandler,
  eventReplayHandler?: EventReplayHandler,
) {
  const app = express();
  app.use(express.json());

  // GET /health - Public endpoint checking database connection
  app.get("/health", async (_req: Request, res: Response) => {
    try {
      const health = await database.checkHealth();
      if (health.healthy) {
        res.status(200).json({ status: "healthy", database: "connected" });
      } else {
        res.status(503).json({ status: "unhealthy", database: "disconnected", error: health.details });
      }
    } catch (error: any) {
      res.status(503).json({ status: "unhealthy", database: "disconnected", error: error.message || String(error) });
    }
  });

  // Issue #839: public currency conversion preview (cached oracle rate, no auth).
  // Rate-limited to 60 req/min per IP. Must stay before the API-key gate.
  app.get("/v1/fx/convert", fxConvertRateLimit, (req: Request, res: Response) => {
    const from = typeof req.query.from === "string" ? req.query.from.toUpperCase() : "";
    const to = typeof req.query.to === "string" ? req.query.to.toUpperCase() : "";
    const amountRaw = typeof req.query.amount === "string" ? req.query.amount : "";

    if (!from || !to || !amountRaw) {
      res.status(400).json({ error: "Query params from, to, and amount are required" });
      return;
    }

    let amountStroops: bigint;
    try {
      amountStroops = BigInt(amountRaw);
    } catch {
      res.status(400).json({ error: "amount must be an integer stroop count" });
      return;
    }
    if (amountStroops < 0n) {
      res.status(400).json({ error: "amount must be non-negative" });
      return;
    }

    const cached = getCachedRate(from, to);
    if (!cached) {
      res.status(404).json({ error: `No cached rate for ${from}/${to}` });
      return;
    }

    const nowSecs = Math.floor(Date.now() / 1000);
    const rateAgeSecs = Math.max(0, nowSecs - cached.updatedAt);
    const stale = rateAgeSecs > DEFAULT_FX_STALENESS_SECS;

    const amountUsdc = Number(amountStroops) / 10 ** USDC_DECIMALS;
    const amountFiat = amountUsdc * cached.rate;

    res.status(200).json({
      from,
      to,
      amount_usdc: formatFixed(amountUsdc, 2),
      amount_fiat: formatFixed(amountFiat, 2),
      rate: formatFixed(cached.rate, 2),
      rate_age_secs: rateAgeSecs,
      stale,
    });
  });

  // Issue #855: Real-time event streaming via Server-Sent Events (SSE)
  const sep10Config = loadSEP10AuthConfig();
  const sseHandler = async (req: Request, res: Response): Promise<void> => {
    const merchantId = (req.query.merchant_id as string) || req.auth?.sub;
    if (!merchantId) {
      res.status(400).json({ error: "Missing required query parameter: merchant_id" });
      return;
    }

    if (req.auth && req.auth.sub !== merchantId && !sep10Config.adminAccounts.has(req.auth.sub)) {
      res.status(403).json({ error: "Token is not authorized for this merchant" });
      return;
    }

    if (!sseManager.canConnect(merchantId)) {
      res.status(429).json({
        error: "Rate limit exceeded: maximum 5 concurrent SSE connections per merchant",
        limit: 5,
      });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    res.flushHeaders?.();

    const eventTypes =
      typeof req.query.event_types === "string"
        ? req.query.event_types.split(",").map((s) => s.trim())
        : undefined;

    const clientId = `${merchantId}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    sseManager.registerClient(clientId, merchantId, res, eventTypes);

    req.on("close", () => {
      sseManager.removeClient(clientId);
    });
  };

  app.get("/v1/events/stream", requireSEP10Auth(sep10Config), sseHandler);
  app.get("/events/stream", requireSEP10Auth(sep10Config), sseHandler);

  // All subsequent routes require API-key authentication
  app.use(requireApiKey);

  // Webhook test delivery and delivery history (Issues #808, #810, #854).
  // Registered after the API-key gate, scoped to manage:webhooks.
  app.use("/webhooks", requireScope("manage:webhooks"));
  registerWebhookRoutes(app, {
    store: new WebhookStore(database.getPool()),
    // The API key identifies the merchant; endpoint ownership is re-checked
    // per request so one merchant cannot read another's delivery log.
    merchantIdFromRequest: (req) =>
      typeof req.header("x-merchant-id") === "string"
        ? (req.header("x-merchant-id") as string)
        : null,
  });

  // Issue #785: GET /v1/payments?merchant_id=&status=&from=&to=&limit=&cursor=
  // Filtered, cursor-paginated payments query. The merchant_id filter is
  // authorized against the SEP-10 JWT subject so a requester can only query
  // their own merchant (admins may query any merchant).
  app.get("/v1/payments", requireScope("read:payments"), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = paymentsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid query parameters", details: parsed.error.flatten() });
        return;
      }

      const { merchant_id, status, from, to, limit, cursor } = parsed.data;

      // Authorization: the SEP-10 JWT subject must match the requested merchant.
      const subject = req.auth?.sub;
      if (!subject) {
        res.status(401).json({ error: "Missing authenticated subject" });
        return;
      }
      if (subject !== merchant_id && !sep10Config.adminAccounts.has(subject)) {
        res.status(403).json({ error: "Token is not authorized for this merchant" });
        return;
      }

      let decodedCursor: { createdAt: string; id: string } | null = null;
      if (cursor) {
        decodedCursor = decodePaymentsCursor(cursor);
        if (!decodedCursor) {
          res.status(400).json({ error: "Invalid cursor" });
          return;
        }
      }

      const result = await database.getPaymentsFiltered({
        merchantId: merchant_id,
        statuses: status,
        from,
        to,
        limit,
        cursor: decodedCursor ?? undefined,
      });

      const nextCursor =
        result.payments.length === limit && result.payments.length > 0
          ? encodePaymentsCursor(
              String(result.payments[result.payments.length - 1].created_at),
              String(result.payments[result.payments.length - 1].id),
            )
          : null;

      res.status(200).json({
        data: result.payments,
        next_cursor: nextCursor,
        total: result.total,
      });
    } catch (error) {
      next(error);
    }
  });

  // GET /payments/:paymentId
  app.get("/payments/:paymentId", requireScope("read:payments"), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { paymentId } = req.params;
      const payment = await database.getPaymentById(paymentId);
      if (!payment) {
        res.status(404).json({ error: "Payment not found" });
        return;
      }
      res.status(200).json(payment);
    } catch (error) {
      next(error);
    }
  });

  // GET /merchants/:merchantId/payments?page=1&limit=20&status=Confirmed
  app.get("/merchants/:merchantId/payments", requireScope("read:payments"), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { merchantId } = req.params;
      const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
      const status = req.query.status ? (req.query.status as string) : undefined;

      if (isNaN(page) || page < 1 || isNaN(limit) || limit < 1) {
        res.status(400).json({ error: "Invalid pagination parameters" });
        return;
      }

      const result = await database.getPaymentsByMerchantPaginated(merchantId, page, limit, status);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  // GET /merchants/:merchantId/disputes?status=Open
  app.get("/merchants/:merchantId/disputes", requireScope("read:payments"), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { merchantId } = req.params;
      const status = req.query.status ? (req.query.status as string) : undefined;

      const disputes = await database.getDisputesByMerchant(merchantId, status);
      res.status(200).json({ disputes });
    } catch (error) {
      next(error);
    }
  });

  // GET /refunds/:refundId
  app.get("/refunds/:refundId", requireScope("read:payments"), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { refundId } = req.params;
      const refund = await database.getRefundById(refundId);
      if (!refund) {
        res.status(404).json({ error: "Refund not found" });
        return;
      }
      res.status(200).json(refund);
    } catch (error) {
      next(error);
    }
  });

  // GET /events?type=PAYMENT/CONFIRMED&from=<ledger>&to=<ledger>
  app.get("/events", requireScope("read:analytics"), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const type = req.query.type ? (req.query.type as string) : undefined;
      const fromLedger = req.query.from ? parseInt(req.query.from as string, 10) : undefined;
      const toLedger = req.query.to ? parseInt(req.query.to as string, 10) : undefined;

      if (fromLedger !== undefined && isNaN(fromLedger)) {
        res.status(400).json({ error: "Invalid 'from' ledger parameter" });
        return;
      }
      if (toLedger !== undefined && isNaN(toLedger)) {
        res.status(400).json({ error: "Invalid 'to' ledger parameter" });
        return;
      }

      const events = await database.getEventsFiltered(type, fromLedger, toLedger);
      res.status(200).json({ events });
    } catch (error) {
      next(error);
    }
  });

  // POST /admin/replay-dlq - Trigger manual replay of dead-letter queue events
  app.post("/admin/replay-dlq", requireScope("admin"), async (_req: Request, res: Response, next: NextFunction) => {
    try {
      if (!replayDlqHandler) {
        res.status(501).json({ error: "DLQ replay handler not configured on server" });
        return;
      }

      const result = await replayDlqHandler();
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  // POST /admin/r

/* … truncated 3514 chars — edit only what you need near the top … */

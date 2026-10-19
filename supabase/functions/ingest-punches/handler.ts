// 收集器上傳端點的處理邏輯（不含 Supabase 連線，方便單元測試）
// 介面規格見 docs/specs/2026-10-19-punch-collector-design.md 第 6 節
import { z } from "zod";

export const MAX_PUNCHES = 1000;
export const MAX_USERS = 5000;

const timestampWithOffset = z.string().datetime({ offset: true });
const deviceUserNo = z.string().min(1).max(24);
const code = z.number().int().min(0).max(255);

const payloadSchema = z.object({
  device: z.object({
    serial_no: z.string().min(1).max(30),
    ip_address: z.string().ip().optional(),
    model: z.string().max(30).optional(),
    firmware_version: z.string().max(50).optional(),
    seen_at: timestampWithOffset,
    record_count: z.number().int().nonnegative().optional(),
    user_count: z.number().int().nonnegative().optional(),
    clock_offset_seconds: z.number().int().optional(),
  }),
  punches: z.array(z.object({
    device_user_no: deviceUserNo,
    punched_at: timestampWithOffset,
    verify_type: code,
    punch_state: code,
  })).max(MAX_PUNCHES).optional(),
  users: z.array(z.object({
    device_user_no: deviceUserNo,
    name: z.string().max(50),
  })).max(MAX_USERS).optional(),
});

export type IngestPayload = z.infer<typeof payloadSchema>;

export interface IngestResult {
  punch_device_id: number;
  received: number;
  inserted: number;
  users_synced: number;
}

export interface Deps {
  collectorKey: string;
  ingest: (payload: IngestPayload) => Promise<IngestResult>;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

// 先雜湊再逐位元組比對，比對時間與金鑰內容無關
async function keyMatches(given: string | null, expected: string): Promise<boolean> {
  if (!given || !expected) return false;
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function handleRequest(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== "POST") {
    return json(405, { error: "method not allowed" });
  }
  if (!(await keyMatches(req.headers.get("x-collector-key"), deps.collectorKey))) {
    return json(401, { error: "unauthorized" });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid JSON" });
  }

  const parsed = payloadSchema.safeParse(body);
  if (!parsed.success) {
    return json(400, {
      error: "invalid payload",
      details: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  try {
    return json(200, await deps.ingest(parsed.data));
  } catch (err) {
    console.error("ingest_punch_batch failed:", err);
    return json(500, { error: "internal error" });
  }
}

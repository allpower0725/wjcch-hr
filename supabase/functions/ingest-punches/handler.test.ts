import { assertEquals, assertFalse } from "jsr:@std/assert@1";
import { handleRequest, type IngestPayload, type IngestResult } from "./handler.ts";

const KEY = "test-collector-key";
const URL = "http://localhost/functions/v1/ingest-punches";
const RESULT: IngestResult = { punch_device_id: 1, received: 1, inserted: 1, users_synced: 0 };

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    device: {
      serial_no: "3088152000240",
      ip_address: "192.168.230.190",
      model: "GT100",
      firmware_version: "Ver 6.60 Jan 23 2015",
      seen_at: "2026-10-19T16:10:57+08:00",
      record_count: 6354,
      user_count: 88,
      clock_offset_seconds: -109,
    },
    punches: [
      { device_user_no: "9021", punched_at: "2026-10-19T07:58:12+08:00", verify_type: 1, punch_state: 0 },
    ],
    ...overrides,
  };
}

function post(body: unknown, key: string | null = KEY): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (key !== null) headers.set("x-collector-key", key);
  return new Request(URL, { method: "POST", headers, body: JSON.stringify(body) });
}

function deps(ingest?: (p: IngestPayload) => Promise<IngestResult>) {
  const calls: IngestPayload[] = [];
  return {
    calls,
    deps: {
      collectorKey: KEY,
      ingest: ingest ?? (async (p: IngestPayload) => {
        calls.push(p);
        return RESULT;
      }),
    },
  };
}

Deno.test("rejects missing key with 401", async () => {
  const d = deps();
  const res = await handleRequest(post(payload(), null), d.deps);
  assertEquals(res.status, 401);
  assertEquals(d.calls.length, 0);
});

Deno.test("rejects wrong key with 401", async () => {
  const res = await handleRequest(post(payload(), "wrong"), deps().deps);
  assertEquals(res.status, 401);
});

Deno.test("rejects everything when server key is not configured", async () => {
  const res = await handleRequest(post(payload(), ""), { ...deps().deps, collectorKey: "" });
  assertEquals(res.status, 401);
});

Deno.test("rejects non-POST with 405", async () => {
  const res = await handleRequest(new Request(URL, { method: "GET", headers: { "x-collector-key": KEY } }), deps().deps);
  assertEquals(res.status, 405);
});

Deno.test("rejects invalid JSON with 400", async () => {
  const req = new Request(URL, { method: "POST", headers: { "x-collector-key": KEY }, body: "{not json" });
  assertEquals((await handleRequest(req, deps().deps)).status, 400);
});

Deno.test("rejects punch without timezone with 400", async () => {
  const body = payload({
    punches: [{ device_user_no: "9021", punched_at: "2026-10-19T07:58:12", verify_type: 1, punch_state: 0 }],
  });
  const res = await handleRequest(post(body), deps().deps);
  assertEquals(res.status, 400);
  const json = await res.json();
  assertEquals(typeof json.error, "string");
});

Deno.test("rejects missing serial number with 400", async () => {
  const body = payload();
  delete (body.device as Record<string, unknown>).serial_no;
  assertEquals((await handleRequest(post(body), deps().deps)).status, 400);
});

Deno.test("rejects more than 1000 punches with 400", async () => {
  const punches = Array.from({ length: 1001 }, (_, i) => ({
    device_user_no: String(1000 + i), punched_at: "2026-10-19T07:58:12+08:00", verify_type: 1, punch_state: 0,
  }));
  assertEquals((await handleRequest(post(payload({ punches })), deps().deps)).status, 400);
});

Deno.test("passes valid payload to ingest and returns its result", async () => {
  const d = deps();
  const res = await handleRequest(post(payload()), d.deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), RESULT);
  assertEquals(d.calls.length, 1);
  assertEquals(d.calls[0].device.serial_no, "3088152000240");
  assertEquals(d.calls[0].punches?.[0].punched_at, "2026-10-19T07:58:12+08:00");
});

Deno.test("accepts heartbeat without punches", async () => {
  const body = payload();
  delete body.punches;
  assertEquals((await handleRequest(post(body), deps().deps)).status, 200);
});

Deno.test("accepts users list", async () => {
  const d = deps();
  const res = await handleRequest(post(payload({ users: [{ device_user_no: "9021", name: "王小明" }] })), d.deps);
  assertEquals(res.status, 200);
  assertEquals(d.calls[0].users?.[0].name, "王小明");
});

Deno.test("accepts punches with unusual dates", async () => {
  const body = payload({
    punches: [{ device_user_no: "9021", punched_at: "2000-01-01T00:00:00+08:00", verify_type: 1, punch_state: 0 }],
  });
  assertEquals((await handleRequest(post(body), deps().deps)).status, 200);
});

Deno.test("returns 500 without leaking db error", async () => {
  const d = deps(() => Promise.reject(new Error("relation public.raw_punch secret detail")));
  const originalError = console.error;
  console.error = () => {};
  try {
    const res = await handleRequest(post(payload()), d.deps);
    assertEquals(res.status, 500);
    assertFalse((await res.text()).includes("secret"));
  } finally {
    console.error = originalError;
  }
});

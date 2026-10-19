// 收集器上傳端點：驗證收集器金鑰與資料格式後，呼叫資料庫函式 ingest_punch_batch
// verify_jwt 已在 supabase/config.toml 關閉，金鑰由 handler 自行比對
import { createClient } from "@supabase/supabase-js";
import { handleRequest, type IngestResult } from "./handler.ts";

// 優先使用新版 secret key；舊的 service_role 金鑰在 2026 年底停用，只當備援
const secretKey: string | undefined =
  JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}").default ??
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!Deno.env.get("SUPABASE_SECRET_KEYS")) {
  console.warn("找不到 SUPABASE_SECRET_KEYS，暫用舊版 service_role 金鑰；請到後台建立新版 secret key");
}

const admin = createClient(Deno.env.get("SUPABASE_URL")!, secretKey!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve((req) =>
  handleRequest(req, {
    collectorKey: Deno.env.get("COLLECTOR_KEY") ?? "",
    ingest: async (payload) => {
      const { data, error } = await admin.rpc("ingest_punch_batch", { p_payload: payload });
      if (error) throw new Error(error.message);
      return data as IngestResult;
    },
  })
);

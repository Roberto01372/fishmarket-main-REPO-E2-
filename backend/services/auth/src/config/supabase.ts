import path from "node:path";
import dotenv from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const rootEnvExamplePath = path.resolve(process.cwd(), "../../../.env.example");

dotenv.config();
dotenv.config({ path: rootEnvExamplePath });

const extractSupabaseUrlFromDatabaseUrl = (databaseUrl?: string) => {
  if (!databaseUrl) {
    return undefined;
  }

  const match = databaseUrl.match(/@([^.]+)\.supabase\.co/);
  return match ? `https://${match[1]}.supabase.co` : undefined;
};

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? extractSupabaseUrlFromDatabaseUrl(process.env.DATABASE_URL) ?? "https://example.supabase.co";
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_API_KEY ?? "placeholder-anon-key";
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE ?? "placeholder-service-role-key";

if (!process.env.SUPABASE_URL && !process.env.VITE_SUPABASE_URL && !process.env.DATABASE_URL) {
  console.warn("[supabase] No Supabase URL was provided. Falling back to the placeholder URL.");
}

export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

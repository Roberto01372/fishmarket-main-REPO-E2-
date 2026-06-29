"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.supabaseAdmin = exports.supabase = void 0;
const node_path_1 = __importDefault(require("node:path"));
const dotenv_1 = __importDefault(require("dotenv"));
const supabase_js_1 = require("@supabase/supabase-js");
const rootEnvExamplePath = node_path_1.default.resolve(process.cwd(), "../../../.env.example");
dotenv_1.default.config();
dotenv_1.default.config({ path: rootEnvExamplePath });
const extractSupabaseUrlFromDatabaseUrl = (databaseUrl) => {
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
exports.supabase = (0, supabase_js_1.createClient)(supabaseUrl, supabaseAnonKey, {
    auth: {
        persistSession: false,
        autoRefreshToken: false,
    },
});
exports.supabaseAdmin = (0, supabase_js_1.createClient)(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
        persistSession: false,
        autoRefreshToken: false,
    },
});
//# sourceMappingURL=supabase.js.map
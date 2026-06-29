"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authMiddleware = void 0;
const supabase_1 = require("../config/supabase");
const authMiddleware = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Bearer token is required" });
    }
    const token = authHeader.slice(7);
    const { data, error } = await supabase_1.supabase.auth.getUser(token);
    if (error || !data.user) {
        return res.status(401).json({ error: "Invalid or expired token" });
    }
    req.user = data.user;
    return next();
};
exports.authMiddleware = authMiddleware;
//# sourceMappingURL=auth.middleware.js.map
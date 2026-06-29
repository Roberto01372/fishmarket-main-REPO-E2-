"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.me = exports.login = exports.register = exports.healthCheck = void 0;
const supabase_1 = require("../config/supabase");
const healthCheck = (_req, res) => {
    res.json({
        status: "ok",
        service: "auth-service",
        timestamp: new Date().toISOString(),
    });
};
exports.healthCheck = healthCheck;
const register = async (req, res) => {
    const { email, password, name } = req.body ?? {};
    if (!email || !password) {
        return res.status(400).json({ error: "Email and password are required" });
    }
    const { data, error } = await supabase_1.supabase.auth.signUp({
        email,
        password,
        options: {
            data: {
                full_name: name ?? "",
            },
        },
    });
    if (error) {
        return res.status(400).json({ error: error.message });
    }
    return res.status(201).json({
        message: "User registered successfully",
        user: data.user,
        session: data.session,
    });
};
exports.register = register;
const login = async (req, res) => {
    const { email, password } = req.body ?? {};
    if (!email || !password) {
        return res.status(400).json({ error: "Email and password are required" });
    }
    const { data, error } = await supabase_1.supabase.auth.signInWithPassword({
        email,
        password,
    });
    if (error) {
        return res.status(401).json({ error: error.message });
    }
    return res.json({
        message: "Login successful",
        user: data.user,
        session: data.session,
    });
};
exports.login = login;
const me = async (req, res) => {
    const user = req.user;
    if (!user) {
        return res.status(401).json({ error: "Authentication required" });
    }
    return res.json({ user });
};
exports.me = me;
//# sourceMappingURL=auth.controller.js.map
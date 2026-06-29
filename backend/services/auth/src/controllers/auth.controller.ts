import type { Request, Response } from "express";
import { supabase } from "../config/supabase";

export const healthCheck = (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "auth-service",
    timestamp: new Date().toISOString(),
  });
};

export const register = async (req: Request, res: Response) => {
  const { email, password, name } = req.body ?? {};

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  const { data, error } = await supabase.auth.signUp({
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

export const login = async (req: Request, res: Response) => {
  const { email, password } = req.body ?? {};

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  const { data, error } = await supabase.auth.signInWithPassword({
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

export const me = async (req: Request, res: Response) => {
  const user = (req as Request & { user?: unknown }).user;

  if (!user) {
    return res.status(401).json({ error: "Authentication required" });
  }

  return res.json({ user });
};

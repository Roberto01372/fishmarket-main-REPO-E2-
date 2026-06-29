"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_controller_1 = require("../controllers/auth.controller");
const auth_middleware_1 = require("../middlewares/auth.middleware");
const router = (0, express_1.Router)();
router.get("/health", auth_controller_1.healthCheck);
router.post("/auth/register", auth_controller_1.register);
router.post("/auth/login", auth_controller_1.login);
router.get("/auth/me", auth_middleware_1.authMiddleware, auth_controller_1.me);
exports.default = router;
//# sourceMappingURL=auth.routes.js.map
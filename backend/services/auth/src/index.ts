import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import authRoutes from "./routes/auth.routes";

dotenv.config();

const app = express();
const port = Number(process.env.PORT ?? 3001);

app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({
    service: "auth-service",
    status: "running",
    timestamp: new Date().toISOString(),
  });
});

app.use("/", authRoutes);

app.listen(port, () => {
  console.log(`Auth service listening on port ${port}`);
});

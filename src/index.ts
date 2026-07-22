import express from "express";
import cors from "cors";
import { logger } from "./lib/logger";
import { startBot } from "./bot";

const app = express();
app.use(cors());
app.use(express.json());

// Health check for Render
app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "UPI QR Checker Bot" });
});

const port = Number(process.env["PORT"] ?? 3000);

app.listen(port, () => {
  logger.info({ port }, "Server listening");
  startBot();
});

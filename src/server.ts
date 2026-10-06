import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { loadConfig } from "./config.js";
import { rateLimit } from "./rateLimit.js";
import { apiRouter } from "./routes.js";

const config = loadConfig();

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.use(express.json({ limit: "256kb" }));
  if (config.allowedOrigins.length > 0) {
    app.use(cors({ origin: config.allowedOrigins }));
  }
  app.use("/api/", rateLimit({ windowMs: config.rateLimitWindowMs, max: config.rateLimitMax }) as never);

  app.use("/api", apiRouter);

  const here = path.dirname(fileURLToPath(import.meta.url));
  const pub = process.env.NODE_ENV === "production"
    ? path.join(here, "public")
    : path.join(here, "..", "public");
  app.use(express.static(pub));
  app.get("/docs", (_req, res) => res.sendFile(path.join(pub, "docs.html")));
  app.get("*", (_req, res) => res.sendFile(path.join(pub, "index.html")));

  return app;
}

if (process.argv[1] != null && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const app = createApp();
  app.listen(config.port, () => {
    process.stdout.write(`model-check listening on :${config.port}\n`);
  });
}

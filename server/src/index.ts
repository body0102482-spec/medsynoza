import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

import authRoutes from "./routes/auth.js";
import casesRoutes from "./routes/cases.js";
import sessionsRoutes from "./routes/sessions.js";
import adminRoutes from "./routes/admin.js";
import studentRoutes from "./routes/student.js";
import categoriesRoutes from "./routes/categories.js";
import siteRoutes from "./routes/site.js";
import transcribeRoutes from "./routes/transcribe.js";
import speechRoutes from "./routes/speech.js";
import paymentsRoutes from "./routes/payments.js";
import {
  isSmtpConfigured,
  verifySmtpConnection,
} from "./services/emailService.js";
import {
  getPaymentProvider,
  isPaymentEnabled,
} from "./services/payment/paymentService.js";
import {
  ensureExamMediaDirs,
  persistentExamRoot,
  packagedExamRoot,
} from "./lib/examMediaPaths.js";
import {
  ensureAiKnowledgeDirs,
  persistentAiKnowledgeRoot,
} from "./lib/aiKnowledgePaths.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../.env") });
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const app = express();
const PORT = process.env.PORT || 5000;

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "frame-src": ["'self'", "https://*.kashier.io"],
      },
    },
  }),
);
app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:5173",
    credentials: true,
  }),
);
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/", limiter);

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "Synoza OSCE Platform",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

app.get("/api/ping", (_req, res) => {
  const start = Date.now();
  res.json({
    pong: true,
    latencyMs: Date.now() - start,
    serverTime: new Date().toISOString(),
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/cases", casesRoutes);
app.use("/api/sessions", sessionsRoutes);
app.use("/api/student", studentRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/categories", categoriesRoutes);
app.use("/api/site", siteRoutes);
app.use("/api/transcribe", transcribeRoutes);
app.use("/api/speech", speechRoutes);
app.use("/api/payments", paymentsRoutes);

ensureExamMediaDirs();
ensureAiKnowledgeDirs();
// Persistent uploads first (survives deploy wipe), then packaged defaults
app.use("/exam", express.static(persistentExamRoot()));
app.use("/exam", express.static(packagedExamRoot()));
app.use("/knowledge", express.static(persistentAiKnowledgeRoot()));

const clientDist = path.join(__dirname, "../../client/dist");
app.use(express.static(clientDist));
app.get("*", (req, res, next) => {
  if (
    req.path.startsWith("/api") ||
    req.path.startsWith("/exam") ||
    req.path.startsWith("/knowledge")
  ) {
    return next();
  }
  res.sendFile(path.join(clientDist, "index.html"), (err) => {
    if (err) next();
  });
});

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  },
);

app
  .listen(PORT, async () => {
    console.log(`Synoza server running on http://localhost:${PORT}`);
    if (isSmtpConfigured()) {
      const ok = await verifySmtpConnection();
      console.log(
        ok
          ? "[email] SMTP ready"
          : "[email] SMTP misconfigured — OTP emails will fail",
      );
    } else {
      console.warn("[email] SMTP not configured — signup OTP disabled");
    }
    if (isPaymentEnabled()) {
      const provider = getPaymentProvider();
      const requested = (
        process.env.PAYMENT_PROVIDER || "paymob"
      ).toLowerCase();
      if (
        (requested === "paymob" && provider === "mock") ||
        (requested === "kashier" && provider === "mock")
      ) {
        console.log(
          `[payments] ${requested} not configured — using instant mock activation until gateway is connected`,
        );
      } else {
        console.log(`[payments] Gateway ready (${provider})`);
      }
    } else {
      console.warn(
        "[payments] Not configured — set PAYMENT_PROVIDER=kashier (or paymob) and the matching gateway keys",
      );
    }
  })
  .on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `Port ${PORT} is already in use. Close the other Synoza server or run:`,
      );
      console.error(
        `  Get-NetTCPConnection -LocalPort ${PORT} -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`,
      );
      process.exit(1);
    }
    throw err;
  });

export default app;

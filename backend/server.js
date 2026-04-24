require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const nodemailer = require("nodemailer");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const app = express();

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

const PORT = Number(process.env.PORT || 3000);
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || FRONTEND_URL)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";
const SENDER_EMAIL = process.env.SENDER_EMAIL || "samrat.dey@laserpowerinfra.com";
const DOCUMENT_ID = process.env.DOCUMENT_ID || "quotation-00119";
const DOCUMENT_TITLE = process.env.DOCUMENT_TITLE || "Quotation LQ26Y-00119";
const DOCUMENT_FILE = process.env.DOCUMENT_FILE || "quotation_LQ26Y-00119.pdf";
const OTP_EXPIRY_MINUTES = Number(process.env.OTP_EXPIRY_MINUTES || 5);
const ACCESS_TOKEN_MINUTES = Number(process.env.ACCESS_TOKEN_MINUTES || 10);
const MAX_OTP_ATTEMPTS = Number(process.env.MAX_OTP_ATTEMPTS || 3);

const DATA_DIR = path.join(__dirname, "data");
const DOC_DIR = path.join(__dirname, "documents");
const ACCESS_LOG_FILE = path.join(DATA_DIR, "access-log.jsonl");
const OTP_LOG_FILE = path.join(DATA_DIR, "otp-log.jsonl");
const SHARE_FILE = path.join(DATA_DIR, "shares.json");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(DOC_DIR, { recursive: true });

app.use(helmet({ crossOriginResourcePolicy: false, contentSecurityPolicy: false }));
app.use(cors({
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Origin not allowed by CORS"));
  },
  credentials: true
}));
app.use(express.json({ limit: "1mb" }));
app.use(rateLimit({ windowMs: 60 * 1000, max: 30 }));

// In-memory OTP store. Production me Redis/PostgreSQL use karein.
const otpStore = new Map();

function nowIso() {
  return new Date().toISOString();
}

function getClientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "";
}

function appendJsonLine(file, record) {
  fs.appendFileSync(file, JSON.stringify(record) + "\n");
}

function writeAccessLog(req, data) {
  appendJsonLine(ACCESS_LOG_FILE, {
    time: nowIso(),
    ip: getClientIp(req),
    userAgent: req.headers["user-agent"] || "",
    ...data
  });
}

function writeOtpLog(req, data) {
  appendJsonLine(OTP_LOG_FILE, {
    time: nowIso(),
    ip: getClientIp(req),
    userAgent: req.headers["user-agent"] || "",
    ...data
  });
}

function readShares() {
  if (!fs.existsSync(SHARE_FILE)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(SHARE_FILE, "utf8").trim();
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeShares(shares) {
  fs.writeFileSync(SHARE_FILE, JSON.stringify(shares, null, 2));
}

function upsertShare(share) {
  const shares = readShares();
  const index = shares.findIndex((item) => item.shareId === share.shareId);

  if (index >= 0) {
    shares[index] = share;
  } else {
    shares.push(share);
  }

  writeShares(shares);
}

function findShareById(shareId) {
  return readShares().find((share) => share.shareId === shareId) || null;
}

function createOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function otpStoreKey(email, shareId) {
  return `${normalizeEmail(email)}::${shareId || "default"}`;
}

function createTransporter() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS || process.env.SMTP_PASS === "PUT_APP_PASSWORD_HERE") {
    return null;
  }

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || "true") === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

async function sendOtpEmail(to, otp, documentTitle) {
  const transporter = createTransporter();

  if (!transporter) {
    console.log("\n================ OTP EMAIL DEBUG ================");
    console.log(`SMTP not configured. OTP for ${to}: ${otp}`);
    console.log("backend/.env me SMTP_PASS set karne ke baad real email jayega.");
    console.log("=================================================\n");
    return { mode: "console" };
  }

  await transporter.sendMail({
    from: SENDER_EMAIL,
    to,
    subject: `OTP for ${documentTitle}`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5">
        <h2>Secure PDF OTP</h2>
        <p>Document: <strong>${documentTitle}</strong></p>
        <p>Your OTP is:</p>
        <h1 style="letter-spacing:4px">${otp}</h1>
        <p>This OTP is valid for ${OTP_EXPIRY_MINUTES} minutes.</p>
        <p>If you did not request this, please ignore this email.</p>
      </div>
    `
  });

  return { mode: "email" };
}

async function sendSecureLinkEmail(share) {
  const transporter = createTransporter();
  const shareUrl = `${FRONTEND_URL}?share=${encodeURIComponent(share.shareId)}`;

  if (!transporter) {
    console.log("\n================ SHARE LINK EMAIL DEBUG ================");
    console.log(`SMTP not configured. Secure link for ${share.recipientEmail}: ${shareUrl}`);
    console.log("backend/.env me SMTP_PASS set karne ke baad real email jayega.");
    console.log("========================================================\n");
    return { mode: "console", shareUrl };
  }

  await transporter.sendMail({
    from: SENDER_EMAIL,
    to: share.recipientEmail,
    subject: `Secure PDF Access: ${share.documentTitle}`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5">
        <h2>Secure PDF Access</h2>
        <p>Document: <strong>${share.documentTitle}</strong></p>
        <p>Please use this secure link:</p>
        <p><a href="${shareUrl}">${shareUrl}</a></p>
        <p>This PDF can be opened only on email OTP sent to <strong>${share.recipientEmail}</strong>.</p>
      </div>
    `
  });

  return { mode: "email", shareUrl };
}

function makeToken(email, shareId) {
  return jwt.sign(
    {
      email,
      documentId: DOCUMENT_ID,
      shareId,
      type: "document_access"
    },
    JWT_SECRET,
    { expiresIn: `${ACCESS_TOKEN_MINUTES}m` }
  );
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;

  if (!token) {
    writeAccessLog(req, { action: "pdf_access", status: "failed", reason: "missing_token", documentId: DOCUMENT_ID });
    return res.status(401).json({ error: "Access token missing" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const share = findShareById(decoded.shareId);

    if (!share || normalizeEmail(share.recipientEmail) !== normalizeEmail(decoded.email)) {
      writeAccessLog(req, {
        action: "pdf_access",
        status: "failed",
        reason: "share_not_valid",
        shareId: decoded.shareId,
        documentId: DOCUMENT_ID,
        email: decoded.email
      });
      return res.status(403).json({ error: "This secure link is no longer valid" });
    }

    req.user = decoded;
    req.share = share;
    return next();
  } catch {
    writeAccessLog(req, { action: "pdf_access", status: "failed", reason: "invalid_or_expired_token", documentId: DOCUMENT_ID });
    return res.status(401).json({ error: "Invalid or expired access token" });
  }
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, documentId: DOCUMENT_ID, title: DOCUMENT_TITLE });
});

app.get("/api/document-info", (req, res) => {
  res.json({
    documentId: DOCUMENT_ID,
    title: DOCUMENT_TITLE,
    senderEmail: SENDER_EMAIL
  });
});

app.get("/api/share/:shareId", (req, res) => {
  const share = findShareById(req.params.shareId);

  if (!share) {
    return res.status(404).json({ error: "Secure link not found" });
  }

  return res.json({
    shareId: share.shareId,
    documentId: share.documentId,
    title: share.documentTitle,
    recipientEmail: share.recipientEmail,
    senderEmail: share.senderEmail,
    createdAt: share.createdAt
  });
});

app.post("/api/create-share", async (req, res) => {
  const recipientEmail = normalizeEmail(req.body.recipientEmail);

  if (!recipientEmail) {
    return res.status(400).json({ error: "Recipient email is required" });
  }

  const share = {
    shareId: uuidv4(),
    documentId: DOCUMENT_ID,
    documentTitle: DOCUMENT_TITLE,
    documentFile: DOCUMENT_FILE,
    recipientEmail,
    senderEmail: SENDER_EMAIL,
    createdAt: nowIso()
  };

  upsertShare(share);

  try {
    const result = await sendSecureLinkEmail(share);
    writeAccessLog(req, {
      action: "create_share",
      status: "success",
      shareId: share.shareId,
      documentId: share.documentId,
      documentTitle: share.documentTitle,
      senderEmail: share.senderEmail,
      recipientEmail: share.recipientEmail,
      deliveryMode: result.mode
    });

    return res.json({
      message: result.mode === "email" ? "Secure link sent to recipient email" : "SMTP not configured. Secure link printed in backend console.",
      shareId: share.shareId,
      shareUrl: result.shareUrl,
      recipientEmail: share.recipientEmail,
      documentTitle: share.documentTitle
    });
  } catch (err) {
    writeAccessLog(req, {
      action: "create_share",
      status: "failed",
      shareId: share.shareId,
      documentId: share.documentId,
      documentTitle: share.documentTitle,
      senderEmail: share.senderEmail,
      recipientEmail: share.recipientEmail,
      error: err.message
    });
    return res.status(500).json({ error: "Could not send secure link email" });
  }
});

app.post("/api/request-otp", async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const shareId = String(req.body.shareId || "").trim();
  const share = findShareById(shareId);

  if (!share) {
    writeOtpLog(req, { action: "request_otp", status: "failed", reason: "share_not_found", shareId, documentId: DOCUMENT_ID, email });
    return res.status(404).json({ error: "Secure link not found" });
  }

  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }

  if (email !== normalizeEmail(share.recipientEmail)) {
    writeOtpLog(req, {
      action: "request_otp",
      status: "blocked",
      reason: "email_not_allowed",
      shareId,
      documentId: share.documentId,
      documentTitle: share.documentTitle,
      email
    });
    return res.status(403).json({ error: "This email is not authorized for this PDF" });
  }

  const otp = createOtp();
  const otpHash = await bcrypt.hash(otp, 10);
  const requestId = uuidv4();

  otpStore.set(otpStoreKey(email, shareId), {
    requestId,
    otpHash,
    expiresAt: Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000,
    attempts: 0,
    shareId,
    documentId: share.documentId
  });

  try {
    const result = await sendOtpEmail(email, otp, share.documentTitle);
    writeOtpLog(req, {
      action: "request_otp",
      status: "sent",
      requestId,
      shareId,
      documentId: share.documentId,
      documentTitle: share.documentTitle,
      senderEmail: share.senderEmail,
      recipientEmail: share.recipientEmail,
      email,
      deliveryMode: result.mode
    });
    return res.json({ message: "OTP sent to recipient email", requestId });
  } catch (err) {
    writeOtpLog(req, {
      action: "request_otp",
      status: "failed",
      requestId,
      shareId,
      documentId: share.documentId,
      documentTitle: share.documentTitle,
      senderEmail: share.senderEmail,
      recipientEmail: share.recipientEmail,
      email,
      error: err.message
    });
    return res.status(500).json({ error: "Could not send OTP email" });
  }
});

app.post("/api/verify-otp", async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const otp = String(req.body.otp || "").trim();
  const shareId = String(req.body.shareId || "").trim();
  const share = findShareById(shareId);

  if (!share) {
    writeOtpLog(req, { action: "verify_otp", status: "failed", reason: "share_not_found", shareId, documentId: DOCUMENT_ID, email });
    return res.status(404).json({ error: "Secure link not found" });
  }

  if (email !== normalizeEmail(share.recipientEmail)) {
    writeOtpLog(req, {
      action: "verify_otp",
      status: "blocked",
      reason: "email_not_allowed",
      shareId,
      documentId: share.documentId,
      documentTitle: share.documentTitle,
      senderEmail: share.senderEmail,
      recipientEmail: share.recipientEmail,
      email
    });
    return res.status(403).json({ error: "This email is not authorized" });
  }

  const storeKey = otpStoreKey(email, shareId);
  const record = otpStore.get(storeKey);

  if (!record) {
    writeOtpLog(req, {
      action: "verify_otp",
      status: "failed",
      reason: "otp_not_requested",
      shareId,
      documentId: share.documentId,
      documentTitle: share.documentTitle,
      senderEmail: share.senderEmail,
      recipientEmail: share.recipientEmail,
      email
    });
    return res.status(400).json({ error: "Please request OTP first" });
  }

  if (record.expiresAt < Date.now()) {
    otpStore.delete(storeKey);
    writeOtpLog(req, {
      action: "verify_otp",
      status: "failed",
      reason: "otp_expired",
      shareId,
      documentId: share.documentId,
      documentTitle: share.documentTitle,
      senderEmail: share.senderEmail,
      recipientEmail: share.recipientEmail,
      email
    });
    return res.status(400).json({ error: "OTP expired" });
  }

  if (record.attempts >= MAX_OTP_ATTEMPTS) {
    otpStore.delete(storeKey);
    writeOtpLog(req, {
      action: "verify_otp",
      status: "failed",
      reason: "too_many_attempts",
      shareId,
      documentId: share.documentId,
      documentTitle: share.documentTitle,
      senderEmail: share.senderEmail,
      recipientEmail: share.recipientEmail,
      email
    });
    return res.status(429).json({ error: "Too many wrong attempts. Request a new OTP." });
  }

  const ok = await bcrypt.compare(otp, record.otpHash);
  if (!ok) {
    record.attempts += 1;
    writeOtpLog(req, {
      action: "verify_otp",
      status: "failed",
      reason: "wrong_otp",
      attempts: record.attempts,
      shareId,
      documentId: share.documentId,
      documentTitle: share.documentTitle,
      senderEmail: share.senderEmail,
      recipientEmail: share.recipientEmail,
      email
    });
    return res.status(400).json({ error: "Invalid OTP" });
  }

  otpStore.delete(storeKey);
  const token = makeToken(email, shareId);

  writeOtpLog(req, {
    action: "verify_otp",
    status: "success",
    shareId,
    documentId: share.documentId,
    documentTitle: share.documentTitle,
    senderEmail: share.senderEmail,
    recipientEmail: share.recipientEmail,
    email
  });
  writeAccessLog(req, {
    action: "pdf_login",
    status: "success",
    shareId,
    documentId: share.documentId,
    documentTitle: share.documentTitle,
    senderEmail: share.senderEmail,
    recipientEmail: share.recipientEmail,
    openedByEmail: email
  });

  return res.json({ token, expiresInMinutes: ACCESS_TOKEN_MINUTES, documentId: share.documentId });
});

app.get("/api/pdf/:documentId", auth, (req, res) => {
  const requestedDocumentId = String(req.params.documentId || "").trim();

  if (requestedDocumentId !== req.share.documentId) {
    writeAccessLog(req, {
      action: "pdf_access",
      status: "failed",
      reason: "wrong_document_id",
      shareId: req.share.shareId,
      documentId: requestedDocumentId,
      documentTitle: req.share.documentTitle,
      senderEmail: req.share.senderEmail,
      recipientEmail: req.share.recipientEmail,
      openedByEmail: req.user.email
    });
    return res.status(404).json({ error: "Document not found" });
  }

  const filePath = path.join(DOC_DIR, req.share.documentFile);
  if (!fs.existsSync(filePath)) {
    writeAccessLog(req, {
      action: "pdf_access",
      status: "failed",
      reason: "file_missing",
      shareId: req.share.shareId,
      documentId: req.share.documentId,
      documentTitle: req.share.documentTitle,
      senderEmail: req.share.senderEmail,
      recipientEmail: req.share.recipientEmail,
      openedByEmail: req.user.email
    });
    return res.status(404).json({ error: "PDF file missing on server" });
  }

  writeAccessLog(req, {
    action: "pdf_opened",
    status: "success",
    shareId: req.share.shareId,
    documentId: req.share.documentId,
    documentTitle: req.share.documentTitle,
    senderEmail: req.share.senderEmail,
    recipientEmail: req.share.recipientEmail,
    openedByEmail: req.user.email
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${path.basename(req.share.documentFile)}"`);
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  fs.createReadStream(filePath).pipe(res);
});

app.get("/api/access-logs", (req, res) => {
  const logs = fs.existsSync(ACCESS_LOG_FILE)
    ? fs.readFileSync(ACCESS_LOG_FILE, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];

  return res.json({ logs: logs.reverse().slice(0, 200) });
});

app.listen(PORT, () => {
  console.log(`Secure PDF backend running on http://localhost:${PORT}`);
  console.log(`Sender email: ${SENDER_EMAIL}`);
});

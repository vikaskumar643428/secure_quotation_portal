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
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || JWT_SECRET;
const ADMIN_EMAIL = normalizeEmail(process.env.ADMIN_EMAIL || "admin@example.com");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change_admin_password";
const ALLOWED_RECIPIENT_EMAIL = normalizeEmail(process.env.ALLOWED_RECIPIENT_EMAIL || "laser.mis8@gmail.com");
const SENDER_EMAIL = process.env.SENDER_EMAIL || "samrat.dey@laserpowerinfra.com";
const DOCUMENT_ID = process.env.DOCUMENT_ID || "quotation-00119";
const DOCUMENT_FILE = process.env.DOCUMENT_FILE || "quotation_LQ26Y-00119.pdf";
const OTP_EXPIRY_MINUTES = Number(process.env.OTP_EXPIRY_MINUTES || 5);
const ACCESS_TOKEN_MINUTES = Number(process.env.ACCESS_TOKEN_MINUTES || 10);
const MAX_OTP_ATTEMPTS = Number(process.env.MAX_OTP_ATTEMPTS || 3);

const DATA_DIR = path.join(__dirname, "data");
const DOC_DIR = path.join(__dirname, "documents");
const ACCESS_LOG_FILE = path.join(DATA_DIR, "access-log.jsonl");
const OTP_LOG_FILE = path.join(DATA_DIR, "otp-log.jsonl");
const SHARE_FILE = path.join(DATA_DIR, "shares.json");
const DOCUMENTS_FILE = path.join(DATA_DIR, "documents.json");

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
app.use(rateLimit({ windowMs: 60 * 1000, max: 20 }));

// In-memory OTP store. Production me Redis/PostgreSQL use karein.
const otpStore = new Map();

function defaultDocuments() {
  return [
    {
      documentId: DOCUMENT_ID,
      title: "Quotation LQ26Y-00119",
      fileName: DOCUMENT_FILE
    }
  ];
}

function ensureDocumentsFile() {
  if (!fs.existsSync(DOCUMENTS_FILE)) {
    fs.writeFileSync(DOCUMENTS_FILE, JSON.stringify(defaultDocuments(), null, 2));
  }
}

function readDocuments() {
  ensureDocumentsFile();

  try {
    const raw = fs.readFileSync(DOCUMENTS_FILE, "utf8").trim();
    const parsed = raw ? JSON.parse(raw) : [];

    return parsed
      .filter((doc) => doc && doc.documentId && doc.fileName)
      .map((doc) => ({
        documentId: String(doc.documentId).trim(),
        title: String(doc.title || doc.documentId).trim(),
        fileName: String(doc.fileName).trim()
      }));
  } catch {
    return defaultDocuments();
  }
}

function getDocumentById(documentId) {
  return readDocuments().find((doc) => doc.documentId === documentId) || null;
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

function findShareById(shareId) {
  return readShares().find((share) => share.shareId === shareId) || null;
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

async function sendOtpEmail(to, otp) {
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
    subject: "OTP for Secure Quotation Access",
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5">
        <h2>Secure Quotation Access OTP</h2>
        <p>Your OTP is:</p>
        <h1 style="letter-spacing:4px">${otp}</h1>
        <p>This OTP is valid for ${OTP_EXPIRY_MINUTES} minutes.</p>
        <p>If you did not request this, please ignore this email.</p>
      </div>
    `
  });

  return { mode: "email" };
}

async function sendQuotationLinkEmail({ to, shareUrl, title }) {
  const transporter = createTransporter();

  if (!transporter) {
    console.log("\n================ SHARE LINK EMAIL DEBUG ================");
    console.log(`SMTP not configured. Secure link for ${to}: ${shareUrl}`);
    console.log("backend/.env me SMTP_PASS set karne ke baad real email jayega.");
    console.log("========================================================\n");
    return { mode: "console" };
  }

  await transporter.sendMail({
    from: SENDER_EMAIL,
    to,
    subject: `Secure access link for ${title}`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5">
        <h2>Secure Quotation Access</h2>
        <p>Your document is available on the secure link below:</p>
        <p><a href="${shareUrl}">${shareUrl}</a></p>
        <p>This link is bound to <strong>${to}</strong> and the PDF will open only after OTP verification on the same email ID.</p>
        <p>If you did not expect this email, please ignore it.</p>
      </div>
    `
  });

  return { mode: "email" };
}

function makeToken(email, shareId, documentId) {
  return jwt.sign(
    { email, documentId: documentId || DOCUMENT_ID, shareId: shareId || null, type: "document_access" },
    JWT_SECRET,
    { expiresIn: `${ACCESS_TOKEN_MINUTES}m` }
  );
}

function makeAdminToken(email) {
  return jwt.sign(
    { email, type: "admin" },
    ADMIN_JWT_SECRET,
    { expiresIn: "12h" }
  );
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;

  if (!token) {
    writeAccessLog(req, { action: "pdf_access", status: "failed", reason: "missing_token" });
    return res.status(401).json({ error: "Access token missing" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    if (decoded.shareId) {
      const share = findShareById(decoded.shareId);

      if (!share || share.documentId !== decoded.documentId || normalizeEmail(share.recipientEmail) !== normalizeEmail(decoded.email)) {
        writeAccessLog(req, { action: "pdf_access", email: decoded.email, status: "failed", reason: "share_not_valid", shareId: decoded.shareId });
        return res.status(403).json({ error: "This secure link is no longer valid" });
      }

      req.share = share;
    } else if (normalizeEmail(decoded.email) !== ALLOWED_RECIPIENT_EMAIL) {
      writeAccessLog(req, { action: "pdf_access", email: decoded.email, status: "failed", reason: "email_not_allowed" });
      return res.status(403).json({ error: "Email not allowed" });
    }

    req.user = decoded;
    next();
  } catch {
    writeAccessLog(req, { action: "pdf_access", status: "failed", reason: "invalid_or_expired_token" });
    return res.status(401).json({ error: "Invalid or expired access token" });
  }
}

function adminAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;

  if (!token) {
    return res.status(401).json({ error: "Admin token missing" });
  }

  try {
    const decoded = jwt.verify(token, ADMIN_JWT_SECRET);

    if (decoded.type !== "admin" || normalizeEmail(decoded.email) !== ADMIN_EMAIL) {
      return res.status(403).json({ error: "Admin access denied" });
    }

    req.admin = decoded;
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired admin token" });
  }
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/admin/login", (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || "");

  if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
    writeAccessLog(req, { action: "admin_login", status: "failed", email });
    return res.status(401).json({ error: "Invalid admin credentials" });
  }

  const token = makeAdminToken(email);
  writeAccessLog(req, { action: "admin_login", status: "success", email });
  return res.json({ token, email });
});

app.get("/api/admin/documents", adminAuth, (req, res) => {
  res.json({ documents: readDocuments() });
});

app.get("/api/document-info", (req, res) => {
  const document = getDocumentById(DOCUMENT_ID) || defaultDocuments()[0];

  res.json({
    documentId: document.documentId,
    title: document.title,
    allowedRecipientEmail: ALLOWED_RECIPIENT_EMAIL
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
    title: share.title,
    allowedRecipientEmail: share.recipientEmail,
    createdAt: share.createdAt
  });
});

app.post("/api/create-share", adminAuth, async (req, res) => {
  const recipientEmail = normalizeEmail(req.body.recipientEmail);
  const documentId = String(req.body.documentId || "").trim();
  const document = getDocumentById(documentId);

  if (!document) {
    return res.status(404).json({ error: "Selected document not found" });
  }

  if (!recipientEmail) {
    return res.status(400).json({ error: "Recipient email is required" });
  }

  const shareId = uuidv4();
  const share = {
    shareId,
    documentId: document.documentId,
    documentFile: document.fileName,
    title: document.title,
    recipientEmail,
    senderEmail: SENDER_EMAIL,
    createdAt: nowIso()
  };

  upsertShare(share);

  const shareUrl = `${FRONTEND_URL}?share=${encodeURIComponent(shareId)}`;

  try {
    const result = await sendQuotationLinkEmail({ to: recipientEmail, shareUrl, title: document.title });
    writeAccessLog(req, {
      action: "create_share",
      status: "success",
      recipientEmail,
      shareId,
      documentId: document.documentId,
      deliveryMode: result.mode,
      createdBy: req.admin.email
    });

    return res.json({
      message: result.mode === "email" ? "Secure link sent to recipient email" : "SMTP not configured. Secure link printed in backend console.",
      shareId,
      shareUrl,
      recipientEmail,
      documentId: document.documentId
    });
  } catch (err) {
    writeAccessLog(req, {
      action: "create_share",
      status: "failed",
      recipientEmail,
      shareId,
      documentId: document.documentId,
      createdBy: req.admin.email,
      error: err.message
    });
    return res.status(500).json({ error: "Could not send secure link email" });
  }
});

app.post("/api/request-otp", async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const shareId = String(req.body.shareId || "").trim();

  let allowedEmail = ALLOWED_RECIPIENT_EMAIL;
  let documentId = DOCUMENT_ID;

  if (shareId) {
    const share = findShareById(shareId);

    if (!share) {
      writeOtpLog(req, { action: "request_otp", email, status: "blocked", reason: "share_not_found", shareId });
      return res.status(404).json({ error: "Secure link not found" });
    }

    allowedEmail = normalizeEmail(share.recipientEmail);
    documentId = share.documentId;
  }

  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }

  if (email !== allowedEmail) {
    writeOtpLog(req, { action: "request_otp", email, status: "blocked", reason: "email_not_allowed", shareId, documentId });
    return res.status(403).json({ error: "This email is not authorized for this document" });
  }

  const otp = createOtp();
  const otpHash = await bcrypt.hash(otp, 10);
  const requestId = uuidv4();

  otpStore.set(otpStoreKey(email, shareId), {
    requestId,
    otpHash,
    expiresAt: Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000,
    attempts: 0,
    shareId: shareId || null,
    documentId
  });

  try {
    const result = await sendOtpEmail(email, otp);
    writeOtpLog(req, { action: "request_otp", email, status: "sent", requestId, deliveryMode: result.mode, shareId, documentId });
    return res.json({
      message: result.mode === "email" ? "OTP sent to authorized email" : "SMTP not configured. OTP printed in backend console.",
      requestId
    });
  } catch (err) {
    writeOtpLog(req, { action: "request_otp", email, status: "failed", requestId, error: err.message, shareId, documentId });
    return res.status(500).json({ error: "Could not send OTP email" });
  }
});

app.post("/api/verify-otp", async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const otp = String(req.body.otp || "").trim();
  const shareId = String(req.body.shareId || "").trim();

  let allowedEmail = ALLOWED_RECIPIENT_EMAIL;
  let documentId = DOCUMENT_ID;

  if (shareId) {
    const share = findShareById(shareId);

    if (!share) {
      writeOtpLog(req, { action: "verify_otp", email, status: "blocked", reason: "share_not_found", shareId });
      return res.status(404).json({ error: "Secure link not found" });
    }

    allowedEmail = normalizeEmail(share.recipientEmail);
    documentId = share.documentId;
  }

  if (email !== allowedEmail) {
    writeOtpLog(req, { action: "verify_otp", email, status: "blocked", reason: "email_not_allowed", shareId, documentId });
    return res.status(403).json({ error: "This email is not authorized" });
  }

  const storeKey = otpStoreKey(email, shareId);
  const record = otpStore.get(storeKey);

  if (!record) {
    writeOtpLog(req, { action: "verify_otp", email, status: "failed", reason: "otp_not_requested", shareId, documentId });
    return res.status(400).json({ error: "Please request OTP first" });
  }

  if ((record.shareId || "") !== (shareId || "")) {
    otpStore.delete(storeKey);
    writeOtpLog(req, { action: "verify_otp", email, status: "failed", reason: "otp_share_mismatch", shareId, documentId });
    return res.status(400).json({ error: "OTP does not match this secure link. Request a new OTP." });
  }

  if (record.expiresAt < Date.now()) {
    otpStore.delete(storeKey);
    writeOtpLog(req, { action: "verify_otp", email, status: "failed", reason: "otp_expired", shareId, documentId });
    return res.status(400).json({ error: "OTP expired" });
  }

  if (record.attempts >= MAX_OTP_ATTEMPTS) {
    otpStore.delete(storeKey);
    writeOtpLog(req, { action: "verify_otp", email, status: "failed", reason: "too_many_attempts", shareId, documentId });
    return res.status(429).json({ error: "Too many wrong attempts. Request a new OTP." });
  }

  const ok = await bcrypt.compare(otp, record.otpHash);

  if (!ok) {
    record.attempts += 1;
    writeOtpLog(req, { action: "verify_otp", email, status: "failed", reason: "wrong_otp", attempts: record.attempts, shareId, documentId });
    return res.status(400).json({ error: "Invalid OTP" });
  }

  otpStore.delete(storeKey);
  const token = makeToken(email, shareId || null, documentId);

  writeOtpLog(req, { action: "verify_otp", email, status: "success", shareId, documentId });
  writeAccessLog(req, { action: "login", email, status: "success", documentId, shareId });

  return res.json({ token, expiresInMinutes: ACCESS_TOKEN_MINUTES, documentId });
});

app.get("/api/pdf/:documentId", auth, (req, res) => {
  const requestedDocumentId = String(req.params.documentId || "").trim();
  const sharedDocument = req.share
    ? { documentId: req.share.documentId, fileName: req.share.documentFile, title: req.share.title }
    : getDocumentById(DOCUMENT_ID);
  const targetDocument = sharedDocument || defaultDocuments()[0];

  if (requestedDocumentId !== targetDocument.documentId) {
    writeAccessLog(req, { action: "pdf_access", email: req.user.email, status: "failed", reason: "wrong_document_id", documentId: requestedDocumentId });
    return res.status(404).json({ error: "Document not found" });
  }

  const filePath = path.join(DOC_DIR, targetDocument.fileName);

  if (!fs.existsSync(filePath)) {
    writeAccessLog(req, { action: "pdf_access", email: req.user.email, status: "failed", reason: "file_missing", documentId: targetDocument.documentId });
    return res.status(404).json({ error: "PDF file missing on server" });
  }

  writeAccessLog(req, { action: "pdf_access", email: req.user.email, status: "success", documentId: targetDocument.documentId, shareId: req.user.shareId || null });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${path.basename(targetDocument.fileName)}"`);
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  fs.createReadStream(filePath).pipe(res);
});

app.get("/api/access-logs", adminAuth, (req, res) => {
  const logs = fs.existsSync(ACCESS_LOG_FILE)
    ? fs.readFileSync(ACCESS_LOG_FILE, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];

  return res.json({ logs: logs.reverse().slice(0, 200) });
});

app.listen(PORT, () => {
  console.log(`Secure quotation backend running on http://localhost:${PORT}`);
  console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
});

# Secure OTP Document Portal

This project sends secure document links by email. Each link is bound to one recipient email ID, and the PDF opens only after OTP verification on that same email.

## What It Does

- Admin login is required before creating a share link.
- You can configure and share multiple PDFs.
- Every share generates a unique secure link like `?share=...`.
- Recipient receives the link on email, requests OTP, verifies OTP, and then opens the PDF.
- Access and OTP events are logged in backend files.

## Data Files

- Document catalog: `backend/data/documents.json`
- Share records: `backend/data/shares.json`
- Access logs: `backend/data/access-log.jsonl`
- OTP logs: `backend/data/otp-log.jsonl`

## Add More PDFs

1. Put the PDF file inside `backend/documents/`
2. Add one entry in `backend/data/documents.json`

Example:

```json
[
  {
    "documentId": "quotation-00119",
    "title": "Quotation LQ26Y-00119",
    "fileName": "quotation_LQ26Y-00119.pdf"
  },
  {
    "documentId": "quotation-00120",
    "title": "Quotation LQ26Y-00120",
    "fileName": "quotation_LQ26Y-00120.pdf"
  }
]
```

## Local Setup

### Backend

```bash
cd backend
cp .env.example .env
npm install
npm start
```

Edit `backend/.env` before real email sending:

```env
SMTP_USER=your_email@example.com
SMTP_PASS=your_app_password
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=strong_admin_password
```

### Frontend

```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

Local URLs:

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:3000`

## Local Flow

### Admin flow

1. Open `http://localhost:5173`
2. Login with `ADMIN_EMAIL` and `ADMIN_PASSWORD`
3. Select a configured PDF
4. Enter recipient email
5. Click `Send Secure Link`

### Recipient flow

1. Recipient opens the emailed secure link
2. Page shows the linked email ID and selected document
3. Recipient clicks `Send OTP`
4. Recipient enters OTP received on the same email
5. PDF opens inside the viewer

## API Endpoints

- `POST /api/admin/login`
- `GET /api/admin/documents`
- `POST /api/create-share`
- `GET /api/share/:shareId`
- `POST /api/request-otp`
- `POST /api/verify-otp`
- `GET /api/pdf/:documentId`
- `GET /api/access-logs`

## Production Deploy

This repo now includes:

- `backend/Dockerfile`
- `frontend/Dockerfile`
- `frontend/nginx.conf`
- `docker-compose.prod.yml`

### Production env

Use `backend/.env` with production values:

```env
PORT=3000
FRONTEND_URL=https://your-domain.com
ALLOWED_ORIGINS=https://your-domain.com
JWT_SECRET=replace_with_long_random_secret
ADMIN_JWT_SECRET=replace_with_another_long_random_secret
ADMIN_EMAIL=admin@your-domain.com
ADMIN_PASSWORD=replace_with_strong_password
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your_email@your-domain.com
SMTP_PASS=your_app_password
SENDER_EMAIL=your_email@your-domain.com
```

### Run production stack

```bash
docker compose -f docker-compose.prod.yml up --build -d
```

The production frontend will be available on:

- `http://your-server:8080`

## Security Notes

- Do not attach the PDF directly in email.
- Share only the secure frontend link.
- Change all default secrets and admin credentials before production use.
- Put the app behind HTTPS in production.
- Consider replacing in-memory OTP storage with Redis or a database for multi-server deployments.

import React, { useEffect, useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:3000";
const shareIdFromUrl = new URLSearchParams(window.location.search).get("share") || "";

function tokenStorageKey(shareId) {
  return shareId ? `quotation_token_${shareId}` : "quotation_token";
}

function App() {
  const [shareId] = useState(shareIdFromUrl);
  const [documentInfo, setDocumentInfo] = useState(null);
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [stage, setStage] = useState("request");
  const [message, setMessage] = useState("");
  const [token, setToken] = useState(localStorage.getItem(tokenStorageKey(shareIdFromUrl)) || "");
  const [pdfUrl, setPdfUrl] = useState("");

  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [adminToken, setAdminToken] = useState(localStorage.getItem("quotation_admin_token") || "");
  const [adminMessage, setAdminMessage] = useState("");
  const [documents, setDocuments] = useState([]);
  const [selectedDocumentId, setSelectedDocumentId] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [shareMessage, setShareMessage] = useState("");
  const [shareUrl, setShareUrl] = useState("");

  useEffect(() => {
    if (!shareId) {
      return;
    }

    fetch(`${API_BASE}/api/share/${shareId}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.error) {
          throw new Error(data.error);
        }
        setDocumentInfo(data);
        setEmail(data.allowedRecipientEmail || "");
      })
      .catch((err) => setMessage(err.message || "Backend not connected"));
  }, [shareId]);

  useEffect(() => {
    if (!adminToken || shareId) {
      return;
    }

    fetch(`${API_BASE}/api/admin/documents`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || "Could not load documents");
        }
        setDocuments(data.documents || []);
        setSelectedDocumentId((current) => current || data.documents?.[0]?.documentId || "");
      })
      .catch((err) => {
        localStorage.removeItem("quotation_admin_token");
        setAdminToken("");
        setAdminMessage(err.message || "Admin session expired");
      });
  }, [adminToken, shareId]);

  useEffect(() => {
    if (!shareId || !token || !documentInfo?.documentId) {
      return;
    }

    fetch(`${API_BASE}/api/pdf/${documentInfo.documentId}`, {
      headers: { Authorization: `Bearer ${token}` }
    })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error("Access expired or invalid");
        }
        const blob = await res.blob();
        setPdfUrl(URL.createObjectURL(blob));
        setStage("viewer");
      })
      .catch(() => {
        localStorage.removeItem(tokenStorageKey(shareId));
        setToken("");
        setStage("request");
      });
  }, [shareId, token, documentInfo]);

  async function requestOtp(e) {
    e.preventDefault();
    setMessage("Sending OTP...");

    const res = await fetch(`${API_BASE}/api/request-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, shareId })
    });
    const data = await res.json();

    if (!res.ok) {
      setMessage(data.error || "Could not send OTP");
      return;
    }

    setStage("verify");
    setMessage(data.message || "OTP sent");
  }

  async function verifyOtp(e) {
    e.preventDefault();
    setMessage("Verifying OTP...");

    const res = await fetch(`${API_BASE}/api/verify-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, otp, shareId })
    });
    const data = await res.json();

    if (!res.ok) {
      setMessage(data.error || "Invalid OTP");
      return;
    }

    localStorage.setItem(tokenStorageKey(shareId), data.token);
    setToken(data.token);
    setMessage("Access granted");
  }

  function logoutViewer() {
    localStorage.removeItem(tokenStorageKey(shareId));
    setToken("");
    setPdfUrl("");
    setOtp("");
    setStage("request");
  }

  async function loginAdmin(e) {
    e.preventDefault();
    setAdminMessage("Signing in...");

    const res = await fetch(`${API_BASE}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: adminEmail, password: adminPassword })
    });
    const data = await res.json();

    if (!res.ok) {
      setAdminMessage(data.error || "Admin login failed");
      return;
    }

    localStorage.setItem("quotation_admin_token", data.token);
    setAdminToken(data.token);
    setAdminMessage(`Signed in as ${data.email}`);
  }

  function logoutAdmin() {
    localStorage.removeItem("quotation_admin_token");
    setAdminToken("");
    setDocuments([]);
    setSelectedDocumentId("");
    setShareUrl("");
    setShareMessage("");
    setAdminPassword("");
  }

  async function createShare(e) {
    e.preventDefault();
    setShareMessage("Sending secure link...");
    setShareUrl("");

    const res = await fetch(`${API_BASE}/api/create-share`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        recipientEmail,
        documentId: selectedDocumentId
      })
    });
    const data = await res.json();

    if (!res.ok) {
      setShareMessage(data.error || "Could not create secure link");
      return;
    }

    setShareMessage(data.message || "Secure link created");
    setShareUrl(data.shareUrl || "");
  }

  if (!shareId) {
    return (
      <main className="page">
        <section className="card">
          <div className="brand">LASER POWER & INFRA LIMITED</div>
          <h1>Admin Share Console</h1>
          <p className="sub">
            Login karke kisi bhi configured PDF ko recipient email se bind karke secure OTP link bhejiye.
          </p>

          {!adminToken && (
            <form onSubmit={loginAdmin} className="form">
              <label>Admin Email</label>
              <input value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} placeholder="Enter admin email" />
              <label>Admin Password</label>
              <input type="password" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} placeholder="Enter admin password" />
              <button type="submit">Login</button>
            </form>
          )}

          {adminToken && (
            <div className="shareSection">
              <div className="toolbar">
                <span>Admin session active</span>
                <button onClick={logoutAdmin} className="secondary">Logout</button>
              </div>

              <form onSubmit={createShare} className="form">
                <label>Select PDF</label>
                <select value={selectedDocumentId} onChange={(e) => setSelectedDocumentId(e.target.value)}>
                  {documents.map((doc) => (
                    <option key={doc.documentId} value={doc.documentId}>
                      {doc.title}
                    </option>
                  ))}
                </select>

                <label>Recipient Email</label>
                <input value={recipientEmail} onChange={(e) => setRecipientEmail(e.target.value)} placeholder="Enter recipient email" />

                <button type="submit">Send Secure Link</button>
              </form>

              {shareMessage && <p className="message">{shareMessage}</p>}
              {shareUrl && (
                <p className="shareLink">
                  Secure link: <a href={shareUrl}>{shareUrl}</a>
                </p>
              )}
            </div>
          )}

          {adminMessage && <p className="message">{adminMessage}</p>}
        </section>
      </main>
    );
  }

  return (
    <main className="page">
      <section className="card">
        <div className="brand">LASER POWER & INFRA LIMITED</div>
        <h1>Secure Document Access</h1>
        <p className="sub">
          Yeh secure link sirf linked email ID ke OTP verification ke baad hi document open karega.
        </p>

        {documentInfo && (
          <div className="info">
            <strong>Document:</strong> {documentInfo.title}<br />
            <strong>Allowed Email:</strong> {documentInfo.allowedRecipientEmail}
          </div>
        )}

        {stage === "request" && (
          <form onSubmit={requestOtp} className="form">
            <label>Email ID</label>
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Authorized email" readOnly />
            <button type="submit">Send OTP</button>
          </form>
        )}

        {stage === "verify" && (
          <form onSubmit={verifyOtp} className="form">
            <label>Enter OTP</label>
            <input value={otp} onChange={(e) => setOtp(e.target.value)} placeholder="6 digit OTP" maxLength="6" />
            <button type="submit">Verify & Open PDF</button>
          </form>
        )}

        {stage === "viewer" && (
          <div className="viewerWrap">
            <div className="toolbar">
              <span>Access granted for: {email}</span>
              <button onClick={logoutViewer}>Logout</button>
            </div>
            <div className="pdfBox">
              <div className="watermark">{email} | {new Date().toLocaleString()}</div>
              {pdfUrl ? <iframe src={pdfUrl} title="Secure quotation PDF" /> : <p>Loading PDF...</p>}
            </div>
          </div>
        )}

        {message && <p className="message">{message}</p>}
      </section>
    </main>
  );
}

export default App;

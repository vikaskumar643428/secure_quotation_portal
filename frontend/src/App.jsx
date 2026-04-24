import React, { useEffect, useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:3000";
const shareIdFromUrl = new URLSearchParams(window.location.search).get("share") || "";

function tokenStorageKey(shareId) {
  return shareId ? `quotation_token_${shareId}` : "quotation_token";
}

function App() {
  const [shareId] = useState(shareIdFromUrl);
  const [documentInfo, setDocumentInfo] = useState(null);
  const [recipientEmail, setRecipientEmail] = useState("");
  const [shareMessage, setShareMessage] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [logs, setLogs] = useState([]);

  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [stage, setStage] = useState("request");
  const [message, setMessage] = useState("");
  const [token, setToken] = useState(localStorage.getItem(tokenStorageKey(shareIdFromUrl)) || "");
  const [pdfUrl, setPdfUrl] = useState("");

  useEffect(() => {
    const url = shareId ? `${API_BASE}/api/share/${shareId}` : `${API_BASE}/api/document-info`;

    fetch(url)
      .then((res) => res.json())
      .then((data) => {
        if (data.error) {
          throw new Error(data.error);
        }
        setDocumentInfo(data);
        if (shareId) {
          setEmail(data.recipientEmail || "");
        }
      })
      .catch((err) => {
        if (shareId) {
          setMessage(err.message || "Backend not connected");
        } else {
          setShareMessage(err.message || "Backend not connected");
        }
      });
  }, [shareId]);

  useEffect(() => {
    if (shareId) {
      return;
    }

    fetch(`${API_BASE}/api/access-logs`)
      .then((res) => res.json())
      .then((data) => setLogs(data.logs || []))
      .catch(() => {});
  }, [shareId, shareUrl]);

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

  async function createShare(e) {
    e.preventDefault();
    setShareMessage("Sending secure link...");
    setShareUrl("");

    const res = await fetch(`${API_BASE}/api/create-share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipientEmail })
    });
    const data = await res.json();

    if (!res.ok) {
      setShareMessage(data.error || "Could not send secure link");
      return;
    }

    setShareMessage(data.message || "Secure link sent");
    setShareUrl(data.shareUrl || "");

    const logRes = await fetch(`${API_BASE}/api/access-logs`);
    const logData = await logRes.json();
    setLogs(logData.logs || []);
  }

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

  if (!shareId) {
    return (
      <main className="page">
        <section className="card">
          <div className="brand">LASER POWER & INFRA LIMITED</div>
          <h1>Secure PDF Share</h1>
          <p className="sub">
            Ek PDF recipient email par OTP se khulega aur har action ka log save hoga.
          </p>

          {documentInfo && (
            <div className="info">
              <strong>PDF:</strong> {documentInfo.title}<br />
              <strong>Sender Email:</strong> {documentInfo.senderEmail}
            </div>
          )}

          <div className="shareSection">
            <form onSubmit={createShare} className="form">
              <label>Party Email</label>
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

          <div className="logsSection">
            <h2>Recent Logs</h2>
            <div className="logsTable">
              <div className="logsHead">
                <span>Time</span>
                <span>Action</span>
                <span>Email</span>
                <span>PDF</span>
              </div>
              {logs.length === 0 && <p className="emptyText">No logs yet.</p>}
              {logs.slice(0, 12).map((log, index) => (
                <div className="logsRow" key={`${log.time}-${index}`}>
                  <span>{new Date(log.time).toLocaleString()}</span>
                  <span>{log.action}</span>
                  <span>{log.openedByEmail || log.recipientEmail || "-"}</span>
                  <span>{log.documentTitle || log.documentId || "-"}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="page">
      <section className="card">
        <div className="brand">LASER POWER & INFRA LIMITED</div>
        <h1>Secure PDF Access</h1>
        <p className="sub">
          Yeh PDF sirf linked email par OTP verify hone ke baad hi khulega.
        </p>

        {documentInfo && (
          <div className="info">
            <strong>PDF:</strong> {documentInfo.title}<br />
            <strong>Recipient Email:</strong> {documentInfo.recipientEmail}
          </div>
        )}

        {stage === "request" && (
          <form onSubmit={requestOtp} className="form">
            <label>Email ID</label>
            <input value={email} onChange={(e) => setEmail(e.target.value)} readOnly />
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
              <span>Opened by: {email}</span>
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

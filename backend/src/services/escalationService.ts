import nodemailer from 'nodemailer';

export interface EscalationMessage {
  role: 'USER' | 'AGENT' | 'SYSTEM';
  content: string;
  createdAt?: string;
}

export interface EscalationPayload {
  caseId: string;
  caseNumber: number;
  userId: string;
  userEmail: string;
  userName: string;
  userQuery: string;
  chatHistory: string;
  messages?: EscalationMessage[];
  issue: string;
  possibleSolution: string;
  workspaceName?: string;
}

const LOGO_SVG_SNAP_HDR = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="239 239 633 633" width="30" height="30" style="display:inline-block;vertical-align:middle;flex-shrink:0"><defs><linearGradient id="pfsh" x1="239" y1="239" x2="886.752" y2="872" gradientUnits="userSpaceOnUse"><stop stop-color="#FF15DC"/><stop offset="1" stop-color="#FFD4F3"/></linearGradient></defs><path d="M555.5 239C585.293 239 611.482 296.766 626.525 384.028C698.867 332.962 758.232 310.635 779.299 331.701C800.365 352.768 778.038 412.132 726.972 484.474C814.234 499.517 872 525.707 872 555.5C872 585.293 814.234 611.482 726.972 626.525C778.039 698.867 800.366 758.233 779.3 779.3C758.233 800.367 698.867 778.039 626.525 726.972C611.482 814.234 585.293 872 555.5 872C525.707 872 499.517 814.235 484.474 726.972C412.132 778.038 352.768 800.366 331.701 779.3C310.634 758.233 332.96 698.867 384.027 626.525C296.765 611.482 239 585.293 239 555.5C239 525.707 296.766 499.517 384.028 484.474C332.962 412.132 310.635 352.768 331.701 331.701C352.768 310.635 412.133 332.962 484.474 384.028C499.517 296.765 525.707 239 555.5 239Z" fill="url(#pfsh)"/></svg>`;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function colorizeHistory(history: string): string {
  return history
    .split('\n')
    .map((line) => {
      const e = esc(line);
      if (/^\[USER\]/i.test(line)) {
        return `<span style="color:#FF15DC;font-weight:600">${e}</span>`;
      }
      if (/^\[AGENT\]/i.test(line)) {
        return `<span style="color:#d4d4d4">${e}</span>`;
      }
      return `<span style="color:#555">${e}</span>`;
    })
    .join('\n');
}

function renderInlineMd(text: string): string {
  return esc(text)
    .replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.1);padding:1px 5px;border-radius:3px;color:#FF15DC;font-family:monospace;font-size:11px">$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
}

function agentMdToHtml(content: string): string {
  const lines = content.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) { code.push(lines[i]); i++; }
      i++;
      out.push(`<pre style="background:rgba(0,0,0,0.25);border-radius:6px;padding:8px 10px;margin:4px 0 6px;font-size:11px;color:rgba(255,255,255,0.6);font-family:monospace;white-space:pre-wrap;overflow-x:auto">${esc(code.join('\n'))}</pre>`);
      continue;
    }
    const hm = line.match(/^#{1,3}\s+(.+)/);
    if (hm) { out.push(`<p style="font-weight:600;color:rgba(255,255,255,0.85);margin:0 0 4px;font-size:13px">${renderInlineMd(hm[1])}</p>`); i++; continue; }
    if (/^[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
        items.push(`<li style="font-size:13px;line-height:1.65;color:rgba(255,255,255,0.68)">${renderInlineMd(lines[i].replace(/^[-*+]\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ul style="list-style:disc;padding-left:14px;margin:0 0 4px">${items.join('')}</ul>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    out.push(`<p style="margin:0 0 4px;font-size:13px;color:rgba(255,255,255,0.7);line-height:1.7">${renderInlineMd(line)}</p>`);
    i++;
  }
  return out.join('');
}

const PF_LOGO_SNAP = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="239 239 633 633" width="16" height="16"><defs><linearGradient id="pfl" x1="239" y1="239" x2="886.752" y2="872" gradientUnits="userSpaceOnUse"><stop stop-color="#FF15DC"/><stop offset="1" stop-color="#FFD4F3"/></linearGradient></defs><path d="M555.5 239C585.293 239 611.482 296.766 626.525 384.028C698.867 332.962 758.232 310.635 779.299 331.701C800.365 352.768 778.038 412.132 726.972 484.474C814.234 499.517 872 525.707 872 555.5C872 585.293 814.234 611.482 726.972 626.525C778.039 698.867 800.366 758.233 779.3 779.3C758.233 800.367 698.867 778.039 626.525 726.972C611.482 814.234 585.293 872 555.5 872C525.707 872 499.517 814.235 484.474 726.972C412.132 778.038 352.768 800.366 331.701 779.3C310.634 758.233 332.96 698.867 384.027 626.525C296.765 611.482 239 585.293 239 555.5C239 525.707 296.766 499.517 384.028 484.474C332.962 412.132 310.635 352.768 331.701 331.701C352.768 310.635 412.133 332.962 484.474 384.028C499.517 296.765 525.707 239 555.5 239Z" fill="url(#pfl)"/></svg>`;

function renderSnapChat(messages: EscalationMessage[]): string {
  return messages.map((msg) => {
    if (msg.role === 'SYSTEM') {
      return `<div style="text-align:center;margin:8px 0 12px"><span style="font-size:11px;color:rgba(255,255,255,0.2);font-style:italic">${esc(msg.content)}</span></div>`;
    }
    if (msg.role === 'USER') {
      return `<div style="display:flex;justify-content:flex-end;margin-bottom:12px">
        <div style="max-width:68%;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.06);border-radius:14px 14px 3px 14px;padding:8px 12px;font-size:13px;color:rgba(255,255,255,0.82);line-height:1.6;white-space:pre-wrap;word-break:break-word">${esc(msg.content)}</div>
      </div>`;
    }
    return `<div style="display:flex;gap:8px;margin-bottom:16px;align-items:flex-start">
      <div style="width:20px;height:20px;flex-shrink:0;margin-top:3px">${PF_LOGO_SNAP}</div>
      <div style="flex:1;min-width:0;padding-top:1px">${agentMdToHtml(msg.content)}</div>
    </div>`;
  }).join('');
}

function createTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

function buildHtml(payload: EscalationPayload): string {
  const {
    caseId, caseNumber, userId, userEmail, userName,
    userQuery, issue, possibleSolution, workspaceName,
  } = payload;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
</head>
<body style="margin:0;padding:0;background:#ffffff;font-family:Inter,Geist,Arial,sans-serif;color:#111111">

<div style="background:#ffffff;padding:40px 24px 48px;max-width:600px;margin:0 auto">

  <p style="font-size:16px;color:#444444;margin:0 0 24px">Hi team,</p>

  <p style="font-size:16px;line-height:1.9;color:#444444;margin:0 0 8px">
    A support case has been escalated and needs your attention.
  </p>

  <p style="font-size:16px;line-height:1.9;color:#444444;margin:0 0 32px">
    The full conversation is attached as an HTML file — open it from your email attachments for a readable snapshot.
  </p>

  <!-- Case info block -->
  <div style="background:#f8f8f8;border-radius:8px;padding:20px 22px;margin-bottom:28px">
    <p style="margin:0 0 4px;font-size:12px;font-weight:600;color:#FF15DC;text-transform:uppercase;letter-spacing:0.06em">Case #${caseNumber}</p>
    <p style="margin:0 0 16px;font-size:15px;font-weight:600;color:#111111">${esc(issue.slice(0, 100))}</p>
    <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">
      <tr>
        <td style="padding:4px 0;width:90px;font-size:13px;color:#888888;vertical-align:top">User</td>
        <td style="padding:4px 0;font-size:13px;color:#111111;font-weight:500">${esc(userName)}</td>
      </tr>
      <tr>
        <td style="padding:4px 0;width:90px;font-size:13px;color:#888888;vertical-align:top">Email</td>
        <td style="padding:4px 0;font-size:13px;color:#111111">${esc(userEmail)}</td>
      </tr>
      <tr>
        <td style="padding:4px 0;width:90px;font-size:13px;color:#888888;vertical-align:top">Workspace</td>
        <td style="padding:4px 0;font-size:13px;color:#111111">${esc(workspaceName || 'General / Account')}</td>
      </tr>
      <tr>
        <td style="padding:4px 0;width:90px;font-size:13px;color:#888888;vertical-align:top">User ID</td>
        <td style="padding:4px 0;font-size:11px;color:#999999;font-family:monospace">${esc(userId)}</td>
      </tr>
    </table>
  </div>

  <!-- User query -->
  <p style="margin:0 0 6px;font-size:12px;font-weight:600;color:#888888;text-transform:uppercase;letter-spacing:0.06em">Initial query</p>
  <p style="font-size:14px;line-height:1.75;color:#333333;margin:0 0 24px;padding:14px 16px;background:#f8f8f8;border-left:3px solid #FF15DC;border-radius:0 6px 6px 0">${esc(userQuery)}</p>

  <!-- Diagnosis -->
  <p style="margin:0 0 6px;font-size:12px;font-weight:600;color:#888888;text-transform:uppercase;letter-spacing:0.06em">Agent diagnosis</p>
  <p style="font-size:14px;line-height:1.75;color:#333333;margin:0 0 16px;padding:14px 16px;background:#f8f8f8;border-left:3px solid #eeeeee;border-radius:0 6px 6px 0">${esc(issue)}</p>

  <!-- Suggested fix -->
  <p style="margin:0 0 6px;font-size:12px;font-weight:600;color:#888888;text-transform:uppercase;letter-spacing:0.06em">Suggested fix</p>
  <p style="font-size:14px;line-height:1.75;color:#333333;margin:0 0 36px;padding:14px 16px;background:#f8f8f8;border-left:3px solid #eeeeee;border-radius:0 6px 6px 0">${esc(possibleSolution)}</p>

  <p style="font-size:16px;line-height:1.9;color:#444444;margin:0 0 40px">
    The HTML attachment has the full chat history rendered exactly as it appeared in the client.
  </p>

  <!-- Footer / signature -->
  <div style="margin-top:40px;padding-top:24px;border-top:1px solid #eeeeee">
    <p style="margin:0;font-size:16px;color:#444444">Best,</p>
    <p style="margin:12px 0 0;font-size:16px;font-weight:600;color:#000000">AI Agents Support Bot</p>
    <p style="margin:6px 0;font-size:14px;color:#666666">Automated escalation &middot; Case #${caseNumber}</p>
    <p style="margin:4px 0;font-size:12px;color:#aaaaaa;font-family:monospace">${esc(caseId)}</p>
    <div style="margin-top:28px">
      <a href="https://ai-agents.com" target="_blank" style="text-decoration:none">
        <img src="https://www.ai-agents.com/logos/logoname.svg" alt="AI Agents" style="height:28px"/>
      </a>
    </div>
  </div>

</div>
</body>
</html>`;
}

function buildSnapshotHtml(payload: EscalationPayload, timestamp: string): string {
  const {
    caseId, caseNumber, userId, userEmail, userName,
    userQuery, chatHistory, messages, issue, possibleSolution, workspaceName,
  } = payload;

  const chatHtml = messages && messages.length > 0
    ? renderSnapChat(messages)
    : `<div class="history-wrap">${colorizeHistory(chatHistory)
        .split('\n')
        .map((line) => `<span class="history-line">${line || '&nbsp;'}</span>`)
        .join('')}</div>`;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Support Case #${caseNumber} — AI Agents</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0e0e10;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e5e5e5;min-height:100vh}
.topbar{height:4px;background:linear-gradient(90deg,#FF15DC,#FFD4F3)}
.page{max-width:760px;margin:0 auto;padding:40px 24px 64px}
.header{display:flex;align-items:center;justify-content:space-between;padding-bottom:20px;margin-bottom:28px;border-bottom:1px solid #1e1e1e}
.header-left{display:flex;align-items:center;gap:12px}
.brand{font-size:16px;font-weight:700;color:#fff;letter-spacing:-0.01em}
.brand-accent{color:#FF15DC}
.badge{display:inline-block;padding:5px 13px;border-radius:20px;font-size:11px;font-weight:600;background:rgba(239,68,68,0.1);color:#f87171;border:1px solid rgba(239,68,68,0.25)}
.hero{margin-bottom:28px}
.hero-eyebrow{font-size:11px;font-weight:600;color:#FF15DC;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:8px}
.hero-title{font-size:28px;font-weight:700;color:#fff;letter-spacing:-0.02em;margin-bottom:6px}
.hero-meta{font-size:12px;color:#555;line-height:1.5}
.hero-meta span{color:#777}
.cards{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px;margin-bottom:28px}
.card{background:#141416;border:1px solid #222224;border-top:2px solid #FF15DC;border-radius:10px;padding:14px 15px}
.card-label{font-size:9px;font-weight:700;color:rgba(255,21,220,0.7);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:5px}
.card-value{font-size:12.5px;color:#d4d4d4;font-weight:500;overflow-wrap:break-word;word-break:break-all;line-height:1.4}
.section{margin-bottom:16px}
.sec-header{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.sec-label{font-size:10px;font-weight:700;color:#FF15DC;text-transform:uppercase;letter-spacing:0.08em}
.sec-bar{flex:1;height:1px;background:linear-gradient(90deg,rgba(255,21,220,0.3),transparent)}
.sec-body{background:#141416;border:1px solid #222224;border-radius:10px;padding:14px 16px;font-size:13px;color:#bbb;line-height:1.7}
.chat-wrap{background:#1C1C1C;border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:20px 24px}
.history-wrap{background:#0a0a0c;border:1px solid #1a1a1e;border-radius:10px;padding:16px 18px;overflow:auto}
.history-line{white-space:pre-wrap;font-family:'SF Mono',Monaco,Menlo,monospace;font-size:11px;line-height:1.7;display:block}
.divider{height:1px;background:linear-gradient(90deg,transparent,rgba(255,21,220,0.2),transparent);margin:28px 0}
.footer{text-align:center;font-size:11px;color:#2e2e2e;line-height:1.8}
.footer strong{color:#444}
</style>
</head>
<body>
<div class="topbar"></div>
<div class="page">

  <div class="header">
    <div class="header-left">
      ${LOGO_SVG_SNAP_HDR}
      <span class="brand">AI Agents<span class="brand-accent"> Support</span></span>
    </div>
    <span class="badge">&#9888; Escalated</span>
  </div>

  <div class="hero">
    <div class="hero-eyebrow">Support Case Report</div>
    <div class="hero-title">Case #${caseNumber}</div>
    <div class="hero-meta">
      Generated: <span>${esc(timestamp)}</span> &nbsp;&middot;&nbsp;
      Case ID: <span style="font-family:monospace;font-size:11px">${esc(caseId)}</span>
    </div>
  </div>

  <div class="cards">
    <div class="card">
      <div class="card-label">User</div>
      <div class="card-value">${esc(userName)}</div>
    </div>
    <div class="card">
      <div class="card-label">Email</div>
      <div class="card-value">${esc(userEmail)}</div>
    </div>
    <div class="card">
      <div class="card-label">Workspace</div>
      <div class="card-value">${esc(workspaceName || 'General / Account')}</div>
    </div>
    <div class="card">
      <div class="card-label">User ID</div>
      <div class="card-value" style="font-size:10px;font-family:monospace;color:#555">${esc(userId)}</div>
    </div>
  </div>

  <div class="section">
    <div class="sec-header">
      <span class="sec-label">User Query</span>
      <div class="sec-bar"></div>
    </div>
    <div class="sec-body">${esc(userQuery)}</div>
  </div>

  <div class="section">
    <div class="sec-header">
      <span class="sec-label">Agent Diagnosis</span>
      <div class="sec-bar"></div>
    </div>
    <div class="sec-body">${esc(issue)}</div>
  </div>

  <div class="section">
    <div class="sec-header">
      <span class="sec-label">Suggested Fix</span>
      <div class="sec-bar"></div>
    </div>
    <div class="sec-body">${esc(possibleSolution)}</div>
  </div>

  <div class="divider"></div>

  <div class="section">
    <div class="sec-header">
      <span class="sec-label">Conversation</span>
      <div class="sec-bar"></div>
    </div>
    <div class="chat-wrap">${chatHtml}</div>
  </div>

  <div class="divider"></div>

  <div class="footer">
    <strong>AI Agents</strong> automated support escalation &nbsp;&middot;&nbsp;
    Case #${caseNumber} &nbsp;&middot;&nbsp;
    <span style="font-family:monospace">${esc(caseId)}</span>
  </div>

</div>
</body>
</html>`;
}

export const escalationService = {
  sendEscalationEmail: async (payload: EscalationPayload): Promise<void> => {
    const { caseNumber, caseId, issue } = payload;

    const adminEmails = (
      process.env.SUPPORT_ADMIN_EMAILS || 'amit@ai-agents.com,shyam@ai-agents.com'
    )
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);

    const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'support-agent@ai-agents.com';
    const subject = `[Support #${caseNumber}] ${issue.slice(0, 60)}`;

    const now = new Date();
    const timestamp = now.toLocaleString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    });

    const html = buildHtml(payload);
    const snapshotHtml = buildSnapshotHtml(payload, timestamp);
    const text = `AI Agents Support Escalation\nCase #${caseNumber}\n\n${issue}\n\nFull details in attached HTML file.`;

    try {
      const transporter = createTransporter();
      await transporter.sendMail({
        from,
        to: adminEmails.join(', '),
        subject,
        html,
        text,
        attachments: [
          {
            filename: `case-${caseNumber}-report.html`,
            content: snapshotHtml,
            contentType: 'text/html',
          },
        ],
      });
      console.log(`[EscalationService] Email sent for case #${caseNumber} to ${adminEmails.join(', ')}`);
    } catch (error) {
      console.error('[EscalationService] sendEscalationEmail failed:', error);
      throw error;
    }
  },
};

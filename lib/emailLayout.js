// One shared look for every email Apex Horizon Bank sends: a branded header
// with the bank icon, a details table, a security footer. Table-based HTML with
// inline styles, because email apps ignore <style> blocks and modern layout.
//
// The logo is a normal https image hosted on the site itself (icons/icon-192.png)
// - email apps block inline SVG and data: images, but load hosted PNGs. The
// bank name is also written as text next to it, so the header still reads
// properly when an app hides images.
const { CANONICAL_URL } = require('./appUrl');

const NAVY = '#0f172a';
const GREEN = '#10b981';
const FONT = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function logoUrl() {
  return `${CANONICAL_URL}/icons/icon-192.png`;
}

// A row of "label ..... value" lines inside a soft card.
// rows: [[label, value], ...]; empty values are skipped. Values are escaped
// unless wrapped as { html: '...' }.
function detailsTable(rows, { title } = {}) {
  const body = (rows || [])
    .filter((r) => r && r[1] != null && r[1] !== '')
    .map(([label, value], i, all) => {
      const shown = value && typeof value === 'object' && 'html' in value ? value.html : esc(value);
      const border = i === all.length - 1 ? '' : 'border-bottom:1px solid #e2e8f0;';
      return `<tr>
        <td style="padding:10px 0;${border}font-size:13px;color:#64748b;vertical-align:top;width:38%;">${esc(label)}</td>
        <td style="padding:10px 0;${border}font-size:13px;color:${NAVY};font-weight:600;text-align:right;vertical-align:top;word-break:break-word;">${shown}</td>
      </tr>`;
    }).join('');
  if (!body) return '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;">
    <tr><td style="padding:6px 18px;">
      ${title ? `<div style="padding:12px 0 2px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#059669;">${esc(title)}</div>` : ''}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${body}</table>
    </td></tr>
  </table>`;
}

// The big centred figure: a verification code or an amount.
function highlightBox(text, { label, sub, color = NAVY, spacing = '0.2em', size = 32 } = {}) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;">
    <tr><td align="center" style="padding:20px 16px;">
      ${label ? `<div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#059669;margin-bottom:6px;">${esc(label)}</div>` : ''}
      <div style="font-size:${size}px;font-weight:700;letter-spacing:${spacing};color:${color};font-family:${FONT};">${esc(text)}</div>
      ${sub ? `<div style="font-size:12px;color:#475569;margin-top:8px;">${esc(sub)}</div>` : ''}
    </td></tr>
  </table>`;
}

function button(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
    <tr><td style="background:${NAVY};border-radius:10px;">
      <a href="${esc(href)}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;font-family:${FONT};">${esc(label)}</a>
    </td></tr>
  </table>`;
}

// tone: 'info' (blue-grey), 'warn' (amber), 'alert' (red)
function notice(html, tone = 'info') {
  const t = {
    info: ['#f1f5f9', '#cbd5e1', '#334155'],
    warn: ['#fffbeb', '#fde68a', '#92400e'],
    alert: ['#fef2f2', '#fecaca', '#991b1b'],
  }[tone] || ['#f1f5f9', '#cbd5e1', '#334155'];
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;background:${t[0]};border:1px solid ${t[1]};border-radius:10px;">
    <tr><td style="padding:14px 16px;font-size:13px;line-height:1.55;color:${t[2]};">${html}</td></tr>
  </table>`;
}

function p(html, style = '') {
  return `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#1e293b;${style}">${html}</p>`;
}

function h(text) {
  return `<h1 style="margin:0 0 14px;font-size:22px;line-height:1.3;color:${NAVY};font-weight:700;">${esc(text)}</h1>`;
}

function steps(items) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 16px;">${items.map((text, i) => `
    <tr>
      <td valign="top" style="width:30px;padding:6px 0;"><div style="width:22px;height:22px;line-height:22px;border-radius:11px;background:${NAVY};color:#fff;font-size:12px;font-weight:700;text-align:center;">${i + 1}</div></td>
      <td valign="top" style="padding:6px 0;font-size:14px;line-height:1.55;color:#1e293b;">${text}</td>
    </tr>`).join('')}</table>`;
}

// Wraps the body of an email in the branded page.
//   preheader - the grey preview line shown next to the subject in inboxes
//   body      - HTML built with the helpers above
//   to        - optional address, shown in the footer ("sent to ...")
//   security  - false to drop the "we'll never ask for your password" tip
function layout({ preheader = '', body, to, security = true } = {}) {
  const year = new Date().getFullYear();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>Apex Horizon Bank</title>
</head>
<body style="margin:0;padding:0;background:#eef2f6;font-family:${FONT};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(preheader)}${'&#847; &zwnj; '.repeat(30)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f6;">
<tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0;">
    <tr><td style="background:${NAVY};padding:22px 28px;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:middle;padding-right:12px;"><img src="${logoUrl()}" width="44" height="44" alt="Apex Horizon Bank" style="display:block;border:0;border-radius:11px;"></td>
        <td style="vertical-align:middle;">
          <div style="font-size:18px;font-weight:700;color:#ffffff;letter-spacing:.01em;font-family:${FONT};">Apex Horizon Bank</div>
          <div style="font-size:11px;color:${GREEN};letter-spacing:.14em;text-transform:uppercase;margin-top:2px;">Banking, above the horizon</div>
        </td>
      </tr></table>
    </td></tr>
    <tr><td style="height:4px;background:${GREEN};font-size:0;line-height:0;">&nbsp;</td></tr>
    <tr><td style="padding:30px 28px 10px;">
      ${body}
    </td></tr>
    <tr><td style="padding:10px 28px 28px;">
      ${security ? `<div style="border-top:1px solid #e2e8f0;padding-top:18px;font-size:12px;line-height:1.6;color:#475569;">
        <strong style="color:${NAVY};">Stay safe:</strong> Apex Horizon Bank will never ask for your password, passcode or a sign-in code by phone, text or email. If something here doesn't look right, sign in from the app yourself instead of using a link, and change your password.
      </div>` : ''}
      <div style="border-top:1px solid #e2e8f0;margin-top:18px;padding-top:16px;font-size:11px;line-height:1.6;color:#94a3b8;">
        ${to ? `This email was sent to ${esc(to)}. ` : ''}It's an automated message, so replies aren't read.<br>
        <a href="${CANONICAL_URL}" style="color:#64748b;">apexhorizonbank.com</a><br><br>
        Apex Horizon Bank is a portfolio demonstration project, not a chartered bank. Accounts hold no real money and are not FDIC insured.<br>
        &copy; ${year} Apex Horizon Bank
      </div>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

module.exports = { esc, layout, detailsTable, highlightBox, button, notice, p, h, steps, logoUrl };

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { PDFDocument, rgb, StandardFonts } from "https://esm.sh/pdf-lib@1.17.1";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY   = Deno.env.get("SERVICE_ROLE_KEY")!;
const FROM_EMAIL     = "\"ILIRH - The International Legal Inteligencia Research herald, India\" <editor@ilirh.in>";
const SITE_URL       = "https://www.ilirh.in";
const LOGO_URL       = "https://www.ilirh.in/android-chrome-192x192.png";
const CERT_TEMPLATE_URL = "https://www.ilirh.in/images/ILIRH-certificate-temp.pdf";
const EDITOR_PASSWORD_HASH = Deno.env.get("EDITOR_PASSWORD_HASH") || "";
const GITHUB_ACTIONS_TOKEN = Deno.env.get("GITHUB_ACTIONS_TOKEN") || "";
const GITHUB_REPO = Deno.env.get("GITHUB_REPO") || "";
const GITHUB_WORKFLOW_FILE = Deno.env.get("GITHUB_WORKFLOW_FILE") || "generate-static-articles.yml";
const GITHUB_BRANCH = Deno.env.get("GITHUB_BRANCH") || "main";
let lastStaticDispatchAt = 0;
const STATIC_REFRESH_MIN_INTERVAL_MS = 60_000;

function slugifyArticleTitle(title: string): string {
  return (title || "article")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[''"]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90) || "article";
}

function buildArticleUrl(articleId: number | null, articleTitle: string): string {
  if (!articleId) return SITE_URL;
  return `${SITE_URL}/articles/${slugifyArticleTitle(articleTitle)}-${articleId}/`;
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value || "");
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function dispatchStaticPageRefresh(reason: string): Promise<{ ok: boolean; configured: boolean; status?: number; text?: string }> {
  if (!GITHUB_ACTIONS_TOKEN || !GITHUB_REPO) return { ok: false, configured: false };
  const now = Date.now();
  if (now - lastStaticDispatchAt < STATIC_REFRESH_MIN_INTERVAL_MS) {
    return { ok: true, configured: true, status: 202, text: "Refresh recently requested; skipped duplicate dispatch." };
  }
  lastStaticDispatchAt = now;
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${encodeURIComponent(GITHUB_WORKFLOW_FILE)}/dispatches`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${GITHUB_ACTIONS_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "ILIRH-Supabase-Edge-Function",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ ref: GITHUB_BRANCH, inputs: { reason: reason || "article_updated" } }),
  });
  const text = await res.text().catch(() => "");
  return { ok: res.ok, configured: true, status: res.status, text: text.slice(0, 300) };
}

// ── Colour palette ────────────────────────────────────────────────────────
const NAVY  = rgb(0.039, 0.086, 0.157);  // #0A1628
const MUTED = rgb(0.478, 0.416, 0.322);  // #7A6A52
const WHITE = rgb(1, 1, 1);

// ── Page dimensions (measured from actual template PDF) ───────────────────
const PAGE_W = 841.5;
const PAGE_H = 595.5;

const LAYOUT = {
  authorName: {
    centerX:    PAGE_W / 2,
    y:          346,
    maxWidth:   480,
    fontSizeMax: 38,
    fontSizeMin: 18,
  },
  articleTitle: {
    xLeft:       90.8,
    xRight:     405.4,
    maxWidth:   314.6,
    yTop:       261.0,
    yBottom:    190.15,
    maxLines:   3,
    fontSizeMax: 12.5,
    fontSizeMin: 7,
  },
  publicationDate: {
    xLeft:      440.2,
    maxWidth:   312.6,
    y:          241.0,
    fontSizeMax: 13,
    fontSizeMin: 8,
  },
  categoryAndCert: {
    xLeft:      440.2,
    maxWidth:   312.6,
    y:          206.0,
    fontSizeMax: 13,
    fontSizeMin: 7,
  },
  footer: {
    whiteoutRect: { x: 375, y: 35, w: 109, h: 13 },
    certValueX:   378,
    y:            38,
    fontSize:     12,
    fontSizeMin:  7,
    maxWidth:     104,
  },
};

type FontLike = { widthOfTextAtSize: (t: string, s: number) => number };

function fitTextToWidth(
  text: string, font: FontLike,
  maxWidth: number, sizeMax: number, sizeMin: number,
): number {
  let size = sizeMax;
  while (size > sizeMin && font.widthOfTextAtSize(text, size) > maxWidth) {
    size -= 0.5;
  }
  return Math.max(size, sizeMin);
}

function wrapText(
  text: string, font: FontLike, fontSize: number, maxWidth: number,
): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let current = "";
    for (const word of para.split(" ")) {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
        current = candidate;
      } else {
        if (current) lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

function autoFontScale(
  text: string, font: FontLike,
  maxWidth: number, maxLines: number,
  sizeMax: number, sizeMin: number,
): { fontSize: number; lines: string[] } {
  let size  = sizeMax;
  let lines = wrapText(text, font, size, maxWidth);
  while (lines.length > maxLines && size > sizeMin) {
    size -= 0.5;
    lines = wrapText(text, font, size, maxWidth);
  }
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    let last = lines[maxLines - 1];
    while (last.length > 1 && font.widthOfTextAtSize(last + "…", size) > maxWidth) {
      last = last.slice(0, -1).trimEnd();
    }
    lines[maxLines - 1] = last + "…";
  }
  return { fontSize: size, lines };
}

function centredX(text: string, font: FontLike, fontSize: number, anchorX: number): number {
  return anchorX - font.widthOfTextAtSize(text, fontSize) / 2;
}



async function generateCertificatePdf(
  authorName:   string,
  articleTitle: string,
  category:     string,
  dateStr:      string,
  certNumber:   string,
  articleId:    number | null,
): Promise<Uint8Array> {

  const tplRes = await fetch(CERT_TEMPLATE_URL);
  if (!tplRes.ok) throw new Error(`Template fetch failed: ${tplRes.status}`);
  const tplBytes = await tplRes.arrayBuffer();

  const pdfDoc = await PDFDocument.load(tplBytes);
  const pages = pdfDoc.getPages();
  const page = pages[0];

  const tplPdf    = await PDFDocument.load(tplBytes);
  const [tplPage] = await pdfDoc.embedPdf(tplPdf, [0]);
  page.drawPage(tplPage, { x: 0, y: 0, width: PAGE_W, height: PAGE_H });

  const serifBold = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
  const serifBI   = await pdfDoc.embedFont(StandardFonts.TimesRomanBoldItalic);
  const serifReg  = await pdfDoc.embedFont(StandardFonts.TimesRoman);

  // ── 5a. AUTHOR NAME ──
  {
    const cfg  = LAYOUT.authorName;
    const size = fitTextToWidth(authorName, serifBI, cfg.maxWidth, cfg.fontSizeMax, cfg.fontSizeMin);
    const x    = centredX(authorName, serifBI, size, cfg.centerX);
    page.drawText(authorName, { x, y: cfg.y, font: serifBI, size, color: NAVY });
  }

  // ── 5b. ARTICLE TITLE — left info-box ──
  {
    const cfg = LAYOUT.articleTitle;
    const { fontSize, lines } = autoFontScale(
      articleTitle, serifBold,
      cfg.maxWidth, cfg.maxLines,
      cfg.fontSizeMax, cfg.fontSizeMin,
    );

    const lineH       = fontSize + 3.5;
    const blockHeight = (lines.length - 1) * lineH;
    const zoneH  = cfg.yBottom - cfg.yTop;
    const startY = cfg.yTop + (zoneH - blockHeight) / 2 + blockHeight;

    for (let i = 0; i < lines.length; i++) {
      page.drawText(lines[i], {
        x: cfg.xLeft,
        y: startY - i * lineH,
        font: serifBold, size: fontSize, color: NAVY,
      });
    }

    // FIX 1: Clickable link annotation over the title block — links directly to published article
    if (articleId) {
      const articleUrl  = buildArticleUrl(articleId, articleTitle);
      const annotBottom = startY - blockHeight - 3;
      const annotTop    = startY + fontSize;
      const annot = pdfDoc.context.obj({
        Type: "Annot", Subtype: "Link",
        Rect: [cfg.xLeft, annotBottom, cfg.xRight, annotTop],
        Border: [0, 0, 0],
        A: { Type: "Action", S: "URI", URI: pdfDoc.context.obj(articleUrl) },
      });
      const ref = pdfDoc.context.register(annot);
      page.node.set(
        pdfDoc.context.obj("Annots") as any,
        pdfDoc.context.obj([ref]) as any,
      );
    }
  }

  // ── 5c. DATE OF PUBLICATION ──
  {
    const cfg  = LAYOUT.publicationDate;
    const size = fitTextToWidth(dateStr, serifBold, cfg.maxWidth, cfg.fontSizeMax, cfg.fontSizeMin);
    page.drawText(dateStr, { x: cfg.xLeft, y: cfg.y, font: serifBold, size, color: NAVY });
  }

  // ── 5d. CATEGORY · CERTIFICATE NUMBER ──
  {
    const cfg     = LAYOUT.categoryAndCert;
    const catCert = `${category}  ·  ${certNumber}`;
    const size    = fitTextToWidth(catCert, serifBold, cfg.maxWidth, cfg.fontSizeMax, cfg.fontSizeMin);
    page.drawText(catCert, { x: cfg.xLeft, y: cfg.y, font: serifBold, size, color: NAVY });
  }

  // ── 5e. FOOTER ──
  {
    const cfg = LAYOUT.footer;
    page.drawRectangle({
      x: cfg.whiteoutRect.x, y: cfg.whiteoutRect.y,
      width: cfg.whiteoutRect.w, height: cfg.whiteoutRect.h,
      color: WHITE, opacity: 1,
    });
    const size = fitTextToWidth(certNumber, serifReg, cfg.maxWidth, cfg.fontSize, cfg.fontSizeMin);
    page.drawText(certNumber, { x: cfg.certValueX, y: cfg.y, font: serifReg, size, color: NAVY });
  }

  return await pdfDoc.save({ useObjectStreams: true });
}

// ── CERT NUMBER ASSIGNMENT ──
async function assignCertNumber(
  authorName: string, authorEmail: string,
  articleId: number | null, articleTitle: string, category: string,
): Promise<string> {
  const countRes = await fetch(
    `${SUPABASE_URL}/rest/v1/certificates?select=cert_number`,
    { headers: dbHeaders },
  );
  const existing: { cert_number: string }[] = await countRes.json();

  let maxSerial = 0;
  if (existing?.length > 0) {
    for (const row of existing) {
      const parts  = row.cert_number.split("/");
      const serial = parseInt(parts[parts.length - 1], 10);
      if (!isNaN(serial) && serial > maxSerial) {
        maxSerial = serial;
      }
    }
  }

  const nextSerial = maxSerial + 1;
  const year       = new Date().getFullYear();
  const certNumber = `ILIRH/${year}/${String(nextSerial).padStart(4, "0")}`;

  await fetch(`${SUPABASE_URL}/rest/v1/certificates`, {
    method: "POST",
    headers: { ...dbHeaders, Prefer: "return=minimal" },
    body: JSON.stringify({
      cert_number:   certNumber,
      article_id:    articleId || null,
      author_name:   authorName,
      author_email:  authorEmail,
      article_title: articleTitle,
      category,
      issued_at:     new Date().toISOString(),
    }),
  });

  return certNumber;
}

// ── EMAIL SENDER ──
const dbHeaders = {
  "Content-Type": "application/json",
  "apikey": SUPABASE_KEY,
  "Authorization": "Bearer " + SUPABASE_KEY,
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function parseDataUrl(dataUrl: string): { mime: string; bytes: Uint8Array } {
  if (!dataUrl || typeof dataUrl !== "string") throw new Error("Missing dataUrl");
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new Error("Invalid dataUrl");
  const mime = m[1];
  const b64 = m[2];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { mime, bytes };
}

async function uploadImageToSupabaseStorage(dataUrl: string): Promise<string> {
  const { mime, bytes } = parseDataUrl(dataUrl);
  const ext = mime.includes("png") ? "png" : "jpg";
  const fileName = `article-images/${Date.now()}_${crypto.randomUUID()}.${ext}`;

  const upRes = await fetch(`${SUPABASE_URL}/storage/v1/object/articles/${fileName}`, {
    method: "PUT",
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": "Bearer " + SUPABASE_KEY,
      "Content-Type": mime,
      "x-upsert": "true",
    },
    body: bytes,
  });

  const t = await upRes.text().catch(() => "");
  if (!upRes.ok) {
    throw new Error(`Storage upload failed (${upRes.status}): ${t || "Unknown error"}`);
  }
  return `${SUPABASE_URL}/storage/v1/object/public/articles/${fileName}`;
}

async function sendEmail(
  to: string, subject: string, html: string,
  attachments?: { filename: string; content: string }[],
) {
  const body: Record<string, unknown> = { from: FROM_EMAIL, to, subject, html };
  if (attachments?.length) body.attachments = attachments;
  const res  = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) console.error("Resend error:", text);
  else console.log("Email sent to:", to);
}

// FIX 5: Rate-limit helper — waits 550ms between sends to stay under 2 req/sec
async function sendEmailRateLimited(
  to: string, subject: string, html: string,
  attachments?: { filename: string; content: string }[],
) {
  await sendEmail(to, subject, html, attachments);
  await new Promise((r) => setTimeout(r, 550)); // max ~1.8 emails/sec — safely under 2/sec limit
}

// ── EMAIL TEMPLATES ──
function headerHtml(): string {
  return `
        <tr>
          <td align="center" bgcolor="#0a1628" style="background-color:#0a1628;padding:0;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
              <tr><td align="center" style="padding:40px 40px 32px;">
                <table cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td align="center" style="padding-bottom:16px;">
                      <table cellpadding="0" cellspacing="0" border="0">
                        <tr>
                          <td align="center" bgcolor="#c9a84c" style="background-color:#c9a84c;padding:2px;">
                            <table cellpadding="0" cellspacing="0" border="0">
                              <tr>
                                <td align="center" bgcolor="#0a1628" style="background-color:#0a1628;padding:6px;">
                                  <img src="${LOGO_URL}" alt="ILIRH Crest" width="120" height="120"
                                    style="display:block;width:120px;height:120px;border:0;outline:none;" />
                                </td>
                              </tr>
                            </table>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <tr><td align="center" style="padding-bottom:6px;">
                    <p style="font-family:Georgia,'Times New Roman',Times,serif;font-size:10px;font-weight:400;letter-spacing:0.35em;text-transform:uppercase;color:#c9a84c;margin:0;line-height:1;">The International Legal Inteligencia Research Herald</p>
                  </td></tr>
                  <tr><td align="center" style="padding-bottom:4px;">
                    <p style="font-family:Georgia,'Times New Roman',Times,serif;font-size:32px;font-weight:700;color:#ffffff;letter-spacing:0.18em;margin:0;line-height:1;">ILIRH</p>
                  </td></tr>
                  <tr><td align="center" style="padding-bottom:20px;">
                    <p style="font-family:Georgia,'Times New Roman',Times,serif;font-size:9.5px;color:#6b8499;letter-spacing:0.22em;text-transform:uppercase;margin:0;line-height:1;">India</p>
                  </td></tr>
                </table>
              </td></tr>
            </table>
          </td>
        </tr>`;
}

function footerHtml(unsubUrl: string): string {
  const year = new Date().getFullYear();
  return `
        <tr><td bgcolor="#c9a84c" style="background-color:#c9a84c;height:1px;font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td align="center" bgcolor="#06101a" style="background-color:#06101a;padding:20px 36px 24px;">
          <p style="font-family:Georgia,serif;font-size:9px;color:#3d5570;line-height:1.8;margin:0;">
            © ${year} The International Legal Inteligencia Research Herald, India. All rights reserved.<br>
            <a href="${unsubUrl}" style="color:#3d5570;text-decoration:underline;">Unsubscribe</a>
          </p>
        </td></tr>`;
}

const SIGNATURE_HTML = `
  <tr><td bgcolor="#f0e9d8" style="background-color:#f0e9d8;padding:16px 44px 20px;border-top:1px solid #cfc9bc;">
    <table cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td>
          <p style="font-family:Georgia,'Times New Roman',Times,serif;font-size:16px;font-style:italic;font-weight:700;color:#0a1628;margin:0 0 2px;">Advocate DR. Ajay Singh Rathore</p>
          <p style="font-family:Georgia,serif;font-size:10px;color:#7a6a52;margin:0 0 1px;letter-spacing:0.06em;">FOUNDER &amp; EDITOR-IN-CHIEF, ILIRH</p>
          <p style="font-family:Georgia,serif;font-size:10px;color:#7a6a52;margin:0;letter-spacing:0.04em;">Advocate, Rajasthan High Court &nbsp;·&nbsp; Member, International Council of Jurists, London</p>
        </td>
      </tr>
    </table>
  </td></tr>`;

function welcomeEmailHtml(name: string, email: string): string {
  const unsubUrl = `${SITE_URL}?unsub=${btoa(email)}`;
  const yearStr  = new Date().getFullYear().toString();
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<style type="text/css">@media only screen and (max-width:600px){.mobile-pad{padding-left:20px !important;padding-right:20px !important;}.email-container{width:100% !important;}}</style>
</head>
<body style="margin:0;padding:0;background-color:#e8e0d4;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#e8e0d4;">
    <tr><td align="center" style="padding:40px 16px;">
      <table class="email-container" width="580" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;width:100%;background-color:#faf6ef;border-top:4px solid #c9a84c;border-bottom:4px solid #c9a84c;">
        ${headerHtml()}
        <tr><td bgcolor="#c9a84c" style="background-color:#c9a84c;height:3px;font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td class="mobile-pad" bgcolor="#faf6ef" style="background-color:#faf6ef;padding:36px 52px 28px;">
          <p style="font-family:Georgia,'Times New Roman',Times,serif;font-size:11px;font-weight:700;letter-spacing:0.3em;text-transform:uppercase;color:#b8963e;margin:0 0 14px;">Welcome to the Herald</p>
          <h2 style="font-family:Georgia,'Times New Roman',Times,serif;font-size:24px;font-weight:700;color:#0a1628;margin:0 0 18px;line-height:1.25;">Dear ${name},</h2>
          <p style="font-family:Georgia,'Times New Roman',Times,serif;font-size:15px;color:#3a3020;line-height:1.9;margin:0 0 16px;">Welcome to <em>The International Legal Inteligencia Research Herald, India</em> — a distinguished platform for rigorous legal scholarship, research, and intellectual discourse.</p>
          <p style="font-family:Georgia,'Times New Roman',Times,serif;font-size:15px;color:#3a3020;line-height:1.9;margin:0 0 16px;">You will henceforth receive timely notifications whenever a new article is published across our categories: <strong>Law, Education, Vedic Science, Political Affairs,</strong> and the <strong>Gen-Z Desk</strong>.</p>
          <p style="font-family:Georgia,'Times New Roman',Times,serif;font-size:15px;color:#3a3020;line-height:1.9;margin:0;">We are grateful for your interest and look forward to enriching your scholarly pursuits.</p>
        </td></tr>
        <tr><td class="mobile-pad" bgcolor="#faf6ef" style="background-color:#faf6ef;padding:16px 52px 44px;">
          <table cellpadding="0" cellspacing="0" border="0"><tr>
            <td bgcolor="#0a1628" style="background-color:#0a1628;border:1px solid #c9a84c;border-radius:1px;">
              <a href="${SITE_URL}" style="display:inline-block;padding:13px 32px;font-family:Georgia,'Times New Roman',Times,serif;font-size:11px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:#c9a84c;text-decoration:none;">Visit the Herald &rarr;</a>
            </td>
          </tr></table>
        </td></tr>
        <tr><td align="center" bgcolor="#0a1628" style="background-color:#0a1628;padding:20px 44px;">
          <p style="font-family:Georgia,'Times New Roman',Times,serif;font-size:10px;font-weight:700;letter-spacing:0.32em;text-transform:uppercase;color:#c9a84c;margin:0;line-height:1;">ILIRH &nbsp;&bull;&nbsp; Est. ${yearStr}</p>
        </td></tr>
        <tr><td bgcolor="#c9a84c" style="background-color:#c9a84c;height:3px;font-size:0;line-height:0;">&nbsp;</td></tr>
        ${SIGNATURE_HTML}
        ${footerHtml(unsubUrl)}
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function articleEmailHtml(
  subName: string, subEmail: string, title: string, author: string,
  category: string, excerpt: string, createdAt: string, articleId: number,
): string {
  const unsubUrl   = `${SITE_URL}?unsub=${btoa(subEmail)}`;
  // Direct link to the generated static article page.
  const articleUrl = buildArticleUrl(articleId, title);
  const dateStr    = new Date(createdAt).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const yearStr    = new Date().getFullYear().toString();
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<style type="text/css">@media only screen and (max-width:600px){.mobile-pad{padding-left:20px !important;padding-right:20px !important;}.email-container{width:100% !important;}}</style>
</head>
<body style="margin:0;padding:0;background-color:#e8e0d4;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#e8e0d4;">
    <tr><td align="center" style="padding:40px 16px;">
      <table class="email-container" width="580" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;width:100%;background-color:#faf6ef;border-top:4px solid #c9a84c;border-bottom:4px solid #c9a84c;">
        ${headerHtml()}
        <tr><td bgcolor="#c9a84c" style="background-color:#c9a84c;height:3px;font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td class="mobile-pad" bgcolor="#faf6ef" style="background-color:#faf6ef;padding:36px 52px 20px;">
          <p style="font-family:Georgia;font-size:10.5px;font-weight:700;letter-spacing:0.28em;text-transform:uppercase;color:#b8963e;margin:0 0 10px;">New Publication</p>
          <p style="font-family:'Lato',Helvetica,Arial,sans-serif;font-size:11px;color:#7a6a52;letter-spacing:0.1em;text-transform:uppercase;margin:0 0 14px;">${category} &nbsp;&bull;&nbsp; ${dateStr}</p>
          <h2 style="font-family:Georgia,'Times New Roman',Times,serif;font-size:22px;font-weight:700;color:#0a1628;margin:0 0 10px;line-height:1.25;">${title}</h2>
          <p style="font-family:Georgia;font-size:13px;color:#7a6a52;margin:0 0 18px;font-style:italic;">By <strong style="color:#0a1628;font-style:normal;">${author}</strong></p>
          ${excerpt ? `<p style="font-family:Georgia,'Times New Roman',Times,serif;font-size:15px;color:#3a3020;line-height:1.9;margin:0 0 20px;">${excerpt}</p>` : ""}
          <p style="font-family:Georgia,'Times New Roman',Times,serif;font-size:15px;color:#3a3020;line-height:1.9;margin:0;">Thank you for subscribing to our publication. We invite you to read our latest article and explore the ideas shaping tomorrow's world.</p>
        </td></tr>
        <tr><td class="mobile-pad" bgcolor="#faf6ef" style="background-color:#faf6ef;padding:16px 52px 44px;">
          <table cellpadding="0" cellspacing="0" border="0"><tr>
            <td bgcolor="#0a1628" style="background-color:#0a1628;border:1px solid #c9a84c;border-radius:1px;">
              <a href="${articleUrl}" style="display:inline-block;padding:13px 32px;font-family:Georgia,'Times New Roman',Times,serif;font-size:11px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:#c9a84c;text-decoration:none;">Read the Article &rarr;</a>
            </td>
          </tr></table>
        </td></tr>
        <tr><td align="center" bgcolor="#0a1628" style="background-color:#0a1628;padding:20px 44px;">
          <p style="font-family:Georgia,'Times New Roman',Times,serif;font-size:10px;font-weight:700;letter-spacing:0.32em;text-transform:uppercase;color:#c9a84c;margin:0;line-height:1;">ILIRH &nbsp;&bull;&nbsp; Est. ${yearStr}</p>
        </td></tr>
        <tr><td bgcolor="#c9a84c" style="background-color:#c9a84c;height:3px;font-size:0;line-height:0;">&nbsp;</td></tr>
        ${SIGNATURE_HTML}
        ${footerHtml(unsubUrl)}
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function authorCertificateEmailHtml(
  authorName: string, authorEmail: string, articleTitle: string,
  articleCategory: string, articleExcerpt: string, publishedAt: string, certNumber: string,
  articleId: number | null,
): string {
  const unsubUrl = `${SITE_URL}?unsub=${btoa(authorEmail)}`;
  const dateStr  = new Date(publishedAt).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
  const yearStr  = new Date().getFullYear().toString();
  // Direct link to the generated static article page.
  const articleUrl = buildArticleUrl(articleId || null, articleTitle);
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<style type="text/css">@media only screen and (max-width:600px){.mobile-pad{padding-left:20px !important;padding-right:20px !important;}.email-container{width:100% !important;}}</style>
</head>
<body style="margin:0;padding:0;background-color:#e8e0d4;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#e8e0d4;">
    <tr><td align="center" style="padding:40px 16px;">
      <table class="email-container" width="580" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;width:100%;background-color:#faf6ef;border-top:4px solid #c9a84c;border-bottom:4px solid #c9a84c;">
        ${headerHtml()}
        <tr><td bgcolor="#c9a84c" style="background-color:#c9a84c;height:3px;font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td class="mobile-pad" bgcolor="#faf6ef" style="background-color:#faf6ef;padding:36px 52px 20px;">
          <p style="font-family:Georgia;font-size:10.5px;font-weight:700;letter-spacing:0.28em;text-transform:uppercase;color:#b8963e;margin:0 0 10px;">Certificate of Publication</p>
          <h2 style="font-family:Georgia,'Times New Roman',Times,serif;font-size:24px;font-weight:700;color:#0a1628;margin:0 0 16px;line-height:1.25;">Dear ${authorName},</h2>
          <p style="font-family:Georgia,'Times New Roman',Times,serif;font-size:15px;color:#3a3020;line-height:1.9;margin:0 0 16px;">On behalf of <em>The International Legal Inteligencia Research Herald, India</em>, it is our honour and privilege to formally certify that your article entitled:</p>
          <blockquote style="margin:0 0 18px;padding:14px 20px;background:#f0e9d8;border-left:4px solid #c9a84c;">
            <p style="font-family:Georgia;font-size:16px;font-weight:700;font-style:italic;color:#0a1628;margin:0;">&ldquo;${articleTitle}&rdquo;</p>
          </blockquote>
          <p style="font-family:Georgia;font-size:15px;color:#3a3020;line-height:1.9;margin:0 0 16px;">has been duly reviewed, accepted, and formally published on <strong>${dateStr}</strong> in the <strong>${articleCategory}</strong> category of the Herald.</p>
          <p style="font-family:Georgia;font-size:14px;color:#7a6a52;margin:0 0 8px;letter-spacing:0.06em;">Certificate Number: <strong style="color:#0a1628;">${certNumber}</strong></p>
          <p style="font-family:Georgia;font-size:15px;color:#3a3020;line-height:1.9;margin:0;">Your certificate of publication is attached to this email as a PDF. We commend your invaluable contribution to the advancement of knowledge.</p>
        </td></tr>
        <tr><td class="mobile-pad" bgcolor="#faf6ef" style="background-color:#faf6ef;padding:16px 52px 44px;">
          <table cellpadding="0" cellspacing="0" border="0"><tr>
            <td bgcolor="#0a1628" style="background-color:#0a1628;border:1px solid #c9a84c;border-radius:1px;">
              <a href="${articleUrl}" style="display:inline-block;padding:13px 32px;font-family:Georgia,'Times New Roman',Times,serif;font-size:11px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:#c9a84c;text-decoration:none;">View Your Article on the Herald &rarr;</a>
            </td>
          </tr></table>
        </td></tr>
        <tr><td align="center" bgcolor="#0a1628" style="background-color:#0a1628;padding:20px 44px;">
          <p style="font-family:Georgia,'Times New Roman',Times,serif;font-size:10px;font-weight:700;letter-spacing:0.32em;text-transform:uppercase;color:#c9a84c;margin:0;line-height:1;">ILIRH &nbsp;&bull;&nbsp; Est. ${yearStr}</p>
        </td></tr>
        <tr><td bgcolor="#c9a84c" style="background-color:#c9a84c;height:3px;font-size:0;line-height:0;">&nbsp;</td></tr>
        ${SIGNATURE_HTML}
        ${footerHtml(unsubUrl)}
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// ── SUBMISSION REJECTED EMAIL ──
function submissionRejectedEmailHtml(
  authorName: string, authorEmail: string, articleTitle: string,
  category: string, submittedAt: string,
): string {
  const unsubUrl = `${SITE_URL}?unsub=${btoa(authorEmail)}`;
  const yearStr  = new Date().getFullYear().toString();
  const dateStr  = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
  const submittedDateStr = submittedAt
    ? new Date(submittedAt).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })
    : dateStr;
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<style type="text/css">@media only screen and (max-width:600px){.mobile-pad{padding-left:20px !important;padding-right:20px !important;}.email-container{width:100% !important;}}</style>
</head>
<body style="margin:0;padding:0;background-color:#e8e0d4;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#e8e0d4;">
    <tr><td align="center" style="padding:40px 16px;">
      <table class="email-container" width="580" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;width:100%;background-color:#faf6ef;border-top:4px solid #c9a84c;border-bottom:4px solid #c9a84c;">
        ${headerHtml()}
        <tr><td bgcolor="#c9a84c" style="background-color:#c9a84c;height:3px;font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td class="mobile-pad" bgcolor="#faf6ef" style="background-color:#faf6ef;padding:36px 52px 28px;">
          <p style="font-family:Georgia;font-size:10.5px;font-weight:700;letter-spacing:0.28em;text-transform:uppercase;color:#b8963e;margin:0 0 10px;">Editorial Decision — ${dateStr}</p>
          <h2 style="font-family:Georgia,'Times New Roman',Times,serif;font-size:24px;font-weight:700;color:#0a1628;margin:0 0 18px;line-height:1.25;">Dear ${authorName},</h2>
          <p style="font-family:Georgia,'Times New Roman',Times,serif;font-size:15px;color:#3a3020;line-height:1.9;margin:0 0 16px;">Thank you for submitting your scholarly work to <em>The International Legal Inteligencia Research Herald, India</em>. We sincerely appreciate the time, effort, and intellectual rigour you invested in preparing your submission.</p>
          <p style="font-family:Georgia,'Times New Roman',Times,serif;font-size:15px;color:#3a3020;line-height:1.9;margin:0 0 20px;">After careful editorial review, we regret to inform you that the following submission has <strong style="color:#0a1628;">not been accepted for publication</strong> at this time:</p>
          <blockquote style="margin:0 0 20px;padding:16px 22px;background:#f0e9d8;border-left:4px solid #c9a84c;">
            <p style="font-family:Georgia;font-size:16px;font-weight:700;font-style:italic;color:#0a1628;margin:0 0 10px;">&ldquo;${articleTitle}&rdquo;</p>
            <table cellpadding="0" cellspacing="0" border="0" style="width:100%;">
              <tr>
                <td style="font-family:Georgia;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#7a6a52;padding:4px 0;width:36%;">Category</td>
                <td style="font-family:Georgia;font-size:13px;color:#3a3020;padding:4px 0;">${category}</td>
              </tr>
              <tr>
                <td style="font-family:Georgia;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#7a6a52;padding:4px 0;">Date of Submission</td>
                <td style="font-family:Georgia;font-size:13px;color:#3a3020;padding:4px 0;">${submittedDateStr}</td>
              </tr>
            </table>
          </blockquote>
          <p style="font-family:Georgia,'Times New Roman',Times,serif;font-size:15px;color:#3a3020;line-height:1.9;margin:0 0 16px;">This decision does not reflect a judgement on the quality of your scholarship, but rather on the editorial requirements and criteria of the Herald at this time. We warmly encourage you to revise and resubmit your work in the future.</p>
          <p style="font-family:Georgia,'Times New Roman',Times,serif;font-size:15px;color:#3a3020;line-height:1.9;margin:0 0 16px;">Should you wish to resubmit a revised version, we welcome you to do so through the <strong>Submit Your Article</strong> portal on our website. Please ensure that your revised submission adheres to our Contributor Guidelines.</p>
          <p style="font-family:Georgia,'Times New Roman',Times,serif;font-size:15px;color:#3a3020;line-height:1.9;margin:0;">We remain grateful for your interest in contributing to the advancement of legal scholarship and discourse through the Herald.</p>
        </td></tr>
        <tr><td class="mobile-pad" bgcolor="#faf6ef" style="background-color:#faf6ef;padding:16px 52px 44px;">
          <table cellpadding="0" cellspacing="0" border="0"><tr>
            <td bgcolor="#0a1628" style="background-color:#0a1628;border:1px solid #c9a84c;border-radius:1px;">
              <a href="${SITE_URL}" style="display:inline-block;padding:13px 32px;font-family:Georgia,'Times New Roman',Times,serif;font-size:11px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:#c9a84c;text-decoration:none;">Submit a New Article &rarr;</a>
            </td>
          </tr></table>
        </td></tr>
        <tr><td align="center" bgcolor="#0a1628" style="background-color:#0a1628;padding:20px 44px;">
          <p style="font-family:Georgia,'Times New Roman',Times,serif;font-size:10px;font-weight:700;letter-spacing:0.32em;text-transform:uppercase;color:#c9a84c;margin:0;line-height:1;">ILIRH &nbsp;&bull;&nbsp; Est. ${yearStr}</p>
        </td></tr>
        <tr><td bgcolor="#c9a84c" style="background-color:#c9a84c;height:3px;font-size:0;line-height:0;">&nbsp;</td></tr>
        ${SIGNATURE_HTML}
        ${footerHtml(unsubUrl)}
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// ── MESSAGE SUBSCRIBERS EMAIL ──
function messageSubscribersEmailHtml(
  subscriberName: string, subscriberEmail: string, messageSubject: string, messageBody: string,
): string {
  const unsubUrl = `${SITE_URL}?unsub=${btoa(subscriberEmail)}`;
  const yearStr  = new Date().getFullYear().toString();
  const dateStr  = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
  // Convert plain newlines to <br> for HTML rendering
  const messageHtml = messageBody.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\n/g,"<br>");
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<style type="text/css">@media only screen and (max-width:600px){.mobile-pad{padding-left:20px !important;padding-right:20px !important;}.email-container{width:100% !important;}}</style>
</head>
<body style="margin:0;padding:0;background-color:#e8e0d4;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#e8e0d4;">
    <tr><td align="center" style="padding:40px 16px;">
      <table class="email-container" width="580" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;width:100%;background-color:#faf6ef;border-top:4px solid #c9a84c;border-bottom:4px solid #c9a84c;">
        ${headerHtml()}
        <tr><td bgcolor="#c9a84c" style="background-color:#c9a84c;height:3px;font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td class="mobile-pad" bgcolor="#faf6ef" style="background-color:#faf6ef;padding:36px 52px 28px;">
          <p style="font-family:Georgia;font-size:10.5px;font-weight:700;letter-spacing:0.28em;text-transform:uppercase;color:#b8963e;margin:0 0 10px;">Message from the Editor — ${dateStr}</p>
          <h2 style="font-family:Georgia,'Times New Roman',Times,serif;font-size:24px;font-weight:700;color:#0a1628;margin:0 0 18px;line-height:1.25;">Dear ${subscriberName},</h2>
          <div style="font-family:Georgia,'Times New Roman',Times,serif;font-size:15px;color:#3a3020;line-height:1.9;margin:0 0 20px;">${messageHtml}</div>
        </td></tr>
        <tr><td class="mobile-pad" bgcolor="#faf6ef" style="background-color:#faf6ef;padding:16px 52px 44px;">
          <table cellpadding="0" cellspacing="0" border="0"><tr>
            <td bgcolor="#0a1628" style="background-color:#0a1628;border:1px solid #c9a84c;border-radius:1px;">
              <a href="${SITE_URL}" style="display:inline-block;padding:13px 32px;font-family:Georgia,'Times New Roman',Times,serif;font-size:11px;font-weight:700;letter-spacing:0.22em;text-transform:uppercase;color:#c9a84c;text-decoration:none;">Visit the Herald &rarr;</a>
            </td>
          </tr></table>
        </td></tr>
        <tr><td align="center" bgcolor="#0a1628" style="background-color:#0a1628;padding:20px 44px;">
          <p style="font-family:Georgia,'Times New Roman',Times,serif;font-size:10px;font-weight:700;letter-spacing:0.32em;text-transform:uppercase;color:#c9a84c;margin:0;line-height:1;">ILIRH &nbsp;&bull;&nbsp; Est. ${yearStr}</p>
        </td></tr>
        <tr><td bgcolor="#c9a84c" style="background-color:#c9a84c;height:3px;font-size:0;line-height:0;">&nbsp;</td></tr>
        ${SIGNATURE_HTML}
        ${footerHtml(unsubUrl)}
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function adminSubscriberEmailHtml(name: string, email: string, subscribedAt: string): string {
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background-color:#e8e0d4;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#e8e0d4;">
    <tr><td align="center" style="padding:40px 16px;">
      <table width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background-color:#faf6ef;border-top:5px solid #c9a84c;">
        <tr><td bgcolor="#0a1628" style="background-color:#0a1628;padding:28px 36px 24px;">
          <p style="font-family:Georgia,'Times New Roman',Times,serif;font-size:9px;font-weight:700;letter-spacing:0.36em;text-transform:uppercase;color:#c9a84c;margin:0 0 8px;">ILIRH — Admin Alert</p>
          <p style="font-family:Georgia,'Times New Roman',Times,serif;font-size:22px;font-weight:700;color:#ffffff;margin:0;line-height:1.2;">New Subscriber</p>
        </td></tr>
        <tr><td bgcolor="#c9a84c" style="background-color:#c9a84c;height:3px;font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td style="padding:36px 40px 28px;">
          <p style="font-family:Georgia,'Times New Roman',Times,serif;font-size:14px;color:#3a3020;line-height:1.7;margin:0 0 24px;">A new reader has subscribed to The International Legal Inteligencia Research Herald, India.</p>
          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid #d5cbbf;border-collapse:collapse;">
            <tr><td style="padding:12px 16px;border-bottom:1px solid #d5cbbf;background-color:#f0e9d8;font-family:Georgia;font-size:10px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:#7a6a52;width:30%;">Name</td>
                <td style="padding:12px 16px;border-bottom:1px solid #d5cbbf;font-family:Georgia;font-size:15px;font-weight:700;color:#0a1628;">${name}</td></tr>
            <tr><td style="padding:12px 16px;border-bottom:1px solid #d5cbbf;background-color:#f0e9d8;font-family:Georgia;font-size:10px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:#7a6a52;">Email</td>
                <td style="padding:12px 16px;border-bottom:1px solid #d5cbbf;font-family:Georgia;font-size:15px;color:#0a1628;"><a href="mailto:${email}" style="color:#1e3a6e;text-decoration:none;">${email}</a></td></tr>
            <tr><td style="padding:12px 16px;background-color:#f0e9d8;font-family:Georgia;font-size:10px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:#7a6a52;">Subscribed At</td>
                <td style="padding:12px 16px;font-family:Georgia;font-size:14px;color:#3a3020;">${subscribedAt}</td></tr>
          </table>
        </td></tr>
        <tr><td bgcolor="#c9a84c" style="background-color:#c9a84c;height:2px;font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td align="center" bgcolor="#0a1628" style="background-color:#0a1628;padding:16px 36px;">
          <p style="font-family:Georgia;font-size:10px;color:#3d5570;margin:0;">ILIRH Admin Notification &nbsp;&bull;&nbsp; <a href="${SITE_URL}" style="color:#6b8499;text-decoration:none;">ilirh.in</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function newSubmissionAdminHtml(s: {
  author_name: string; author_email: string; occupation?: string;
  institution?: string; title: string; category: string;
  abstract?: string; id?: string | number;
}): string {
  const year = new Date().getFullYear();
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/></head>
<body style="margin:0;padding:0;background-color:#e8e0d4;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#e8e0d4;">
    <tr><td align="center" style="padding:40px 16px;">
      <table width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background-color:#faf6ef;border-top:5px solid #c9a84c;">
        <tr><td bgcolor="#0a1628" style="background-color:#0a1628;padding:28px 36px 24px;">
          <p style="font-family:Georgia,'Times New Roman',Times,serif;font-size:9px;font-weight:700;letter-spacing:0.36em;text-transform:uppercase;color:#c9a84c;margin:0 0 8px;">ILIRH — Admin Alert</p>
          <p style="font-family:Georgia,'Times New Roman',Times,serif;font-size:22px;font-weight:700;color:#ffffff;margin:0;line-height:1.2;">New Article Submission</p>
        </td></tr>
        <tr><td bgcolor="#c9a84c" style="background-color:#c9a84c;height:3px;font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td style="padding:36px 40px 28px;">
          <p style="font-family:Georgia,'Times New Roman',Times,serif;font-size:14px;color:#3a3020;line-height:1.7;margin:0 0 24px;">A new article has been submitted by a contributor for editorial review.</p>
          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid #d5cbbf;border-collapse:collapse;">
            <tr><td style="padding:10px 14px;border-bottom:1px solid #d5cbbf;background-color:#f0e9d8;font-family:Georgia;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#7a6a52;width:32%;">Author</td>
                <td style="padding:10px 14px;border-bottom:1px solid #d5cbbf;font-family:Georgia;font-size:14px;font-weight:700;color:#0a1628;">${s.author_name}</td></tr>
            <tr><td style="padding:10px 14px;border-bottom:1px solid #d5cbbf;background-color:#f0e9d8;font-family:Georgia;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#7a6a52;">Email</td>
                <td style="padding:10px 14px;border-bottom:1px solid #d5cbbf;font-family:Georgia;font-size:13px;color:#1e3a6e;"><a href="mailto:${s.author_email}" style="color:#1e3a6e;">${s.author_email}</a></td></tr>
            <tr><td style="padding:10px 14px;border-bottom:1px solid #d5cbbf;background-color:#f0e9d8;font-family:Georgia;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#7a6a52;">Occupation</td>
                <td style="padding:10px 14px;border-bottom:1px solid #d5cbbf;font-family:Georgia;font-size:14px;color:#3a3020;">${s.occupation || "—"}</td></tr>
            <tr><td style="padding:10px 14px;border-bottom:1px solid #d5cbbf;background-color:#f0e9d8;font-family:Georgia;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#7a6a52;">Institution</td>
                <td style="padding:10px 14px;border-bottom:1px solid #d5cbbf;font-family:Georgia;font-size:14px;color:#3a3020;">${s.institution || "—"}</td></tr>
            <tr><td style="padding:10px 14px;border-bottom:1px solid #d5cbbf;background-color:#f0e9d8;font-family:Georgia;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#7a6a52;">Category</td>
                <td style="padding:10px 14px;border-bottom:1px solid #d5cbbf;font-family:Georgia;font-size:14px;font-weight:700;color:#b8963e;">${s.category}</td></tr>
            <tr><td style="padding:10px 14px;background-color:#f0e9d8;font-family:Georgia;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#7a6a52;">Title</td>
                <td style="padding:10px 14px;font-family:Georgia;font-size:15px;font-weight:700;color:#0a1628;font-style:italic;">"${s.title}"</td></tr>
          </table>
          ${s.abstract ? `
          <div style="margin-top:20px;padding:16px 18px;background:#f0e9d8;border-left:4px solid #c9a84c;">
            <p style="font-family:Georgia;font-size:10px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:#7a6a52;margin:0 0 8px;">Abstract</p>
            <p style="font-family:Georgia;font-size:14px;color:#3a3020;line-height:1.7;margin:0;">${s.abstract}</p>
          </div>` : ""}
          <p style="font-family:Georgia;font-size:13px;color:#7a6a52;margin-top:20px;">Log in to the Editor Panel and navigate to <strong>Review Submissions</strong> to view the full file, edit details, and publish or reject this submission.</p>
        </td></tr>
        <tr><td bgcolor="#c9a84c" style="background-color:#c9a84c;height:2px;font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td align="center" bgcolor="#0a1628" style="background-color:#0a1628;padding:16px 36px;">
          <p style="font-family:Georgia;font-size:10px;color:#3d5570;margin:0;">ILIRH Admin Notification &nbsp;&bull;&nbsp; <a href="${SITE_URL}" style="color:#6b8499;text-decoration:none;">ilirh.in</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// ── MAIN REQUEST HANDLER ──
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST")    return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  try {
    const body = await req.json();
    const type = body.type;

    if (type === "verify_editor_password") {
      const configured = !!EDITOR_PASSWORD_HASH;
      const ok = configured && await sha256Hex(String(body.password || "")) === EDITOR_PASSWORD_HASH;
      return new Response(JSON.stringify({ ok, configured }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (type === "refresh_static_pages") {
      const out = await dispatchStaticPageRefresh(String(body.reason || "article_updated"));
      return new Response(JSON.stringify(out), { status: out.ok || !out.configured ? 200 : 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (type === "welcome") {
      const { name, email } = body;
      await sendEmail(email, "Welcome to the International Legal Inteligencia Research Herald", welcomeEmailHtml(name, email));
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (type === "auto_subscribe_submitter") {
      const name = String(body.name || "").trim();
      const email = String(body.email || "").trim().toLowerCase();
      if (!name || !email) {
        return new Response(JSON.stringify({ ok: false, error: "Missing name or email" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const subRes = await fetch(`${SUPABASE_URL}/rest/v1/subscribers`, {
        method: "POST",
        headers: { ...dbHeaders, "Prefer": "resolution=ignore-duplicates,return=representation" },
        body: JSON.stringify({ name, email }),
      });
      if (!subRes.ok && subRes.status !== 409) {
        const text = await subRes.text().catch(() => "");
        return new Response(JSON.stringify({ ok: false, error: `Subscribe failed (${subRes.status}): ${text.slice(0, 200)}` }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const insertedRows = await subRes.json().catch(() => []);
      await sendEmail(email, "Welcome to the International Legal Inteligencia Research Herald", welcomeEmailHtml(name, email));
      return new Response(JSON.stringify({ ok: true, inserted: Array.isArray(insertedRows) && insertedRows.length > 0 }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (type === "upload_article_image") {
      const { dataUrl } = body;
      const url = await uploadImageToSupabaseStorage(dataUrl);
      return new Response(JSON.stringify({ ok: true, url }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (type === "new_article") {
      const { title, author, category, excerpt, created_at, id } = body.article;
      const subRes = await fetch(`${SUPABASE_URL}/rest/v1/subscribers?select=name,email`, { headers: dbHeaders });
      const subscribers: { name: string; email: string }[] = await subRes.json();
      if (!subscribers?.length) {
        return new Response(JSON.stringify({ ok: true, sent: 0 }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      let sent = 0;
      // FIX 5: Send one by one with 550ms delay to stay under Resend's 2 req/sec limit
      for (const sub of subscribers) {
        await sendEmailRateLimited(
          sub.email,
          `New Article: ${title} — ILIRH`,
          articleEmailHtml(sub.name, sub.email, title, author, category, excerpt || "", created_at, id)
        );
        sent++;
      }
      return new Response(JSON.stringify({ ok: true, sent }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (type === "author_certificate") {
      const { author_name, author_email, article_title, article_category, article_excerpt, published_at, article_id } = body;

      const certNumber = await assignCertNumber(author_name, author_email, article_id || null, article_title, article_category);

      const dateStr = new Date(published_at || new Date()).toLocaleDateString("en-IN", {
        day: "numeric", month: "long", year: "numeric",
      });

      const pdfBytes = await generateCertificatePdf(author_name, article_title, article_category, dateStr, certNumber, article_id || null);

      let base64Pdf = "";
      const chunk   = 8192;
      for (let i = 0; i < pdfBytes.length; i += chunk) {
        base64Pdf += String.fromCharCode(...pdfBytes.slice(i, i + chunk));
      }
      base64Pdf = btoa(base64Pdf);

      const safeTitle = article_title.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 40);
      const filename  = `ILIRH_Certificate_${certNumber.replace(/\//g, "-")}_${safeTitle}.pdf`;

      // FIX 1: Pass article_id to email template so button links directly to the article
      const html = authorCertificateEmailHtml(author_name, author_email, article_title, article_category, article_excerpt || "", published_at || new Date().toISOString(), certNumber, article_id || null);
      await sendEmail(author_email, `Certificate of Publication — "${article_title}" — ILIRH`, html, [{ filename, content: base64Pdf }]);

      return new Response(JSON.stringify({ ok: true, cert_number: certNumber }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    // ── NEW SUBMISSION ADMIN NOTIFICATION ──
if (type === "new_submission") {
  const { submission } = body;
  const adminEmail = "adv.dr.ajaysinghrathore777@gmail.com";
  const subject = `New Article Submission: "${submission.title}" — ILIRH`;
  const html = newSubmissionAdminHtml(submission);
  await sendEmail(adminEmail, subject, html);
  return new Response(
    JSON.stringify({ ok: true }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

    // ── SUBMISSION REJECTED — notify author ──
    if (type === "submission_rejected") {
      const { author_name, author_email, article_title, category, submitted_at } = body;
      const subject = `Your Article Submission — Editorial Decision — ILIRH`;
      const html = submissionRejectedEmailHtml(
        author_name, author_email, article_title,
        category || "", submitted_at || "",
      );
      await sendEmail(author_email, subject, html);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── MESSAGE SUBSCRIBERS (all or selected) ──
    if (type === "message_subscribers") {
      const { subject: msgSubject, message: msgBody, recipients } = body;
      let targets: { name: string; email: string }[] = [];
      if (recipients && Array.isArray(recipients) && recipients.length > 0) {
        targets = recipients;
      } else {
        const subRes = await fetch(`${SUPABASE_URL}/rest/v1/subscribers?select=name,email`, { headers: dbHeaders });
        targets = await subRes.json();
      }
      if (!targets?.length) {
        return new Response(JSON.stringify({ ok: true, sent: 0 }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      let sent = 0;
      for (const sub of targets) {
        await sendEmailRateLimited(
          sub.email,
          msgSubject,
          messageSubscribersEmailHtml(sub.name, sub.email, msgSubject, msgBody),
        );
        sent++;
      }
      return new Response(JSON.stringify({ ok: true, sent }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (type === "admin_new_subscriber") {
      const { name, email, subscribed_at, admin_email } = body;
      await sendEmail(admin_email || "adv.dr.ajaysinghrathore777@gmail.com", `New Subscriber: ${name} — ILIRH`, adminSubscriberEmailHtml(name, email, subscribed_at));
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── REMOVE SUBSCRIBER (uses service role key to bypass RLS) ──
    if (type === "remove_subscriber") {
      const { id } = body;
      if (!id) {
        return new Response(JSON.stringify({ ok: false, error: "Missing id" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const delRes = await fetch(`${SUPABASE_URL}/rest/v1/subscribers?id=eq.${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { ...dbHeaders, "Prefer": "return=representation" },
      });
      const text = await delRes.text();
      let deleted = false;
      if (delRes.status === 204) {
        deleted = true;
      } else if (delRes.status === 200) {
        try {
          const rows = JSON.parse(text);
          deleted = Array.isArray(rows) && rows.length > 0;
        } catch (_) { deleted = false; }
      }
      if (!deleted) {
        return new Response(JSON.stringify({ ok: false, error: `Delete failed (status ${delRes.status}): ${text.slice(0, 200)}` }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "Unknown type" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err) {
    console.error("Function error:", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  
});

// api/tally-webhook.js
// ─────────────────────────────────────────────────────────────────────────────
// Vercel serverless function — no external DB needed.
// Uses /tmp/leads.json for persistence within the same warm instance,
// AND returns all stored leads on every GET so the frontend stays in sync.
//
// IMPORTANT: Vercel /tmp is shared within the same instance but not across
// instances. For 100% reliability, leads are ALSO sent as the POST response
// body so the frontend can save them directly to localStorage.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const STORE = join('/tmp', 'crm_leads.json');
const MAX   = 500;

// ── Helpers ──────────────────────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, tally-signature');
}

function readStore() {
  try {
    if (!existsSync(STORE)) return [];
    return JSON.parse(readFileSync(STORE, 'utf8'));
  } catch { return []; }
}

function writeStore(leads) {
  try { writeFileSync(STORE, JSON.stringify(leads), 'utf8'); } catch(e) { console.error('Write error:', e); }
}

function uid() {
  return `tally_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function parseTally(payload) {
  const data   = payload.data   || payload;
  const fields = data.fields    || payload.fields || [];

  const lead = {
    id:         uid(),
    source:     data.formName || payload.formName || 'Tally Form',
    receivedAt: Date.now(),
    status:     'new',
    name:       '',
    email:      '',
    phone:      '',
    fields:     {},
    raw:        payload,
  };

  // Parse Tally fields array
  if (Array.isArray(fields)) {
    fields.forEach(f => {
      const label = (f.label || f.key || '').trim();
      let   value = f.value;
      if (Array.isArray(value)) value = value.join(', ');
      value = String(value ?? '').trim();
      if (!label || !value) return;

      const low = label.toLowerCase();
      if (!lead.name  && (low.includes('name')   || low === 'full name'))                            lead.name  = value;
      if (!lead.email && low.includes('email'))                                                       lead.email = value;
      if (!lead.phone && (low.includes('phone')  || low.includes('mobile') || low.includes('tel'))) lead.phone = value;

      lead.fields[label] = value;
    });
  }

  // Top-level fallbacks (some Tally plans send flat structure)
  if (!lead.name  && (data.name  || payload.name))  lead.name  = data.name  || payload.name;
  if (!lead.email && (data.email || payload.email))  lead.email = data.email || payload.email;
  if (!lead.phone && (data.phone || payload.phone))  lead.phone = data.phone || payload.phone;

  return lead;
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  cors(res);

  // Preflight
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET — CRM frontend polls this every 15s ────────────────────────────────
  if (req.method === 'GET') {
    const since    = parseInt(req.query.since || '0', 10);
    const allLeads = readStore();
    const fresh    = since > 0 ? allLeads.filter(l => l.receivedAt > since) : allLeads;

    console.log(`[GET] since=${since} → returning ${fresh.length} of ${allLeads.length} leads`);

    return res.status(200).json({
      ok:     true,
      leads:  fresh,
      total:  allLeads.length,
    });
  }

  // ── POST — Tally sends form submissions here ───────────────────────────────
  if (req.method === 'POST') {
    try {
      const payload = req.body;

      // Log everything — visible in Vercel Dashboard → Functions → Logs
      console.log('━━━ TALLY SUBMISSION ━━━');
      console.log('Time:', new Date().toISOString());
      console.log('Body:', JSON.stringify(payload, null, 2));

      // Parse into a clean lead object
      const lead = parseTally(payload);
      console.log('Parsed lead:', JSON.stringify(lead, null, 2));

      // Save to /tmp store
      const existing = readStore();
      const updated  = [lead, ...existing].slice(0, MAX);
      writeStore(updated);
      console.log(`Store updated. Total leads: ${updated.length}`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━');

      // Return the lead in the response — frontend saves it directly to
      // localStorage so it appears immediately even before the next poll
      return res.status(200).json({
        ok:      true,
        message: 'Lead received and saved',
        leadId:  lead.id,
        lead:    lead,          // ← frontend uses this for instant display
        time:    new Date().toISOString(),
      });

    } catch (err) {
      console.error('POST error:', err);
      // Still return 200 so Tally doesn't retry endlessly
      return res.status(200).json({ ok: false, error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

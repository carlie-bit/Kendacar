import { useState, useMemo, useEffect, useRef, createContext, useContext, Fragment } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, LineChart, Line, CartesianGrid, Area, AreaChart
} from "recharts";

// =============================================================================
//  SUPABASE — live data source + sign-in + editing
//  The dashboard reads these tables on load. When an approved person signs in
//  (magic link to their email), grant/donation/investment entries become
//  editable right on the page and changes write straight back here — no rebuild,
//  no git push. Nothing is bundled: data loads only for signed-in family and advisors.
// =============================================================================

const SUPABASE_URL = "https://kzbghmzxujnslzskiqir.supabase.co";
const SUPABASE_KEY = "sb_publishable_fZ6jZCjd_URdPqT9dS-VIQ_FrAh4PDL";
const REST = SUPABASE_URL + "/rest/v1/";
const AUTH = SUPABASE_URL + "/auth/v1/";
const FUNCTIONS = SUPABASE_URL + "/functions/v1/";
const SESSION_KEY = "kendacar_session";

// ---- read (uses the public key) ----
// ---- session storage ----
function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}
function saveSession(s) {
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else localStorage.removeItem(SESSION_KEY);
}
function emailFromToken(tok) {
  try { return JSON.parse(atob(tok.split(".")[1])).email || ""; } catch { return ""; }
}

// Parse the #access_token=... fragment Supabase appends after a magic-link click.
function sessionFromHash() {
  if (!window.location.hash) return null;
  const p = new URLSearchParams(window.location.hash.slice(1));
  const access_token = p.get("access_token");
  const refresh_token = p.get("refresh_token");
  if (!access_token) return null;
  // strip the tokens from the URL so they aren't left in the address bar
  history.replaceState(null, "", window.location.pathname + window.location.search);
  return {
    access_token, refresh_token,
    expires_at: Date.now() + (Number(p.get("expires_in") || 3600) * 1000),
    email: emailFromToken(access_token),
    type: p.get("type") || "",
  };
}

const toSession = j => ({
  access_token: j.access_token, refresh_token: j.refresh_token,
  expires_at: Date.now() + (Number(j.expires_in || 3600) * 1000), email: emailFromToken(j.access_token),
});
const authHeaders = { apikey: SUPABASE_KEY, "Content-Type": "application/json" };
const returnHere = () => encodeURIComponent(window.location.origin + window.location.pathname);

async function signInWithPassword(email, password) {
  const res = await fetch(AUTH + "token?grant_type=password", {
    method: "POST", headers: authHeaders, body: JSON.stringify({ email, password }),
  });
  const j = await res.json().catch(() => ({}));
  if (res.ok) return toSession(j);
  const text = String(j.error_description || j.msg || j.message || "");
  if (/not confirmed/i.test(text)) throw new Error("Please confirm your email first, using the link we sent when you created your password.");
  if (res.status === 429) throw new Error("Too many attempts. Wait a minute, then try again.");
  throw new Error("That email and password don't match.");
}

// First time: choose a password. Supabase emails a one-time confirmation link so nobody can
// claim a family member's address before they do; after that it's just email and password.
async function createPasswordFor(email, password) {
  const res = await fetch(AUTH + "signup?redirect_to=" + returnHere(), {
    method: "POST", headers: authHeaders, body: JSON.stringify({ email, password }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const text = String(j.msg || j.message || j.error_description || "");
    // New accounts are refused by a database rule unless the email is on the Kendacar list.
    if (/database error|not_on_allowlist/i.test(text)) throw new Error("That email isn't on the Kendacar list. Check the spelling, or contact the foundation.");
    if (/already registered|already exists/i.test(text)) throw new Error("That email already has a password. Sign in, or use Forgot password.");
    if (res.status === 429) throw new Error("Too many attempts. Wait a minute, then try again.");
    throw new Error(text || "Couldn't create your password (" + res.status + ").");
  }
  // While email confirmation is on, no session comes back until the link is clicked.
  return j.access_token ? toSession(j) : null;
}

// Supabase answers the same way whether or not the address has an account, so this form
// can't be used to find out who is on the list.
async function sendPasswordReset(email) {
  const res = await fetch(AUTH + "recover?redirect_to=" + returnHere(), {
    method: "POST", headers: authHeaders, body: JSON.stringify({ email }),
  });
  if (res.status === 429) throw new Error("Too many attempts. Wait a minute, then try again.");
  return true;
}

async function updatePassword(session, password) {
  const res = await fetch(AUTH + "user", {
    method: "PUT", headers: { ...authHeaders, Authorization: "Bearer " + session.access_token },
    body: JSON.stringify({ password }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(j.msg || j.message || "Couldn't save the password (" + res.status + ")."));
  return true;
}

// Exchange a refresh token for a fresh access token.
async function refreshSession(session) {
  if (!session?.refresh_token) return null;
  const res = await fetch(AUTH + "token?grant_type=refresh_token", {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  });
  if (!res.ok) return null;
  const j = await res.json();
  return { access_token: j.access_token, refresh_token: j.refresh_token,
    expires_at: Date.now() + (Number(j.expires_in || 3600) * 1000), email: emailFromToken(j.access_token) };
}

// A write request authenticated as the signed-in user. Refreshes once on 401.
async function authedWrite(session, setSession, method, path, body) {
  let s = session;
  if (s && s.expires_at && s.expires_at < Date.now() + 60000) {
    const r = await refreshSession(s); if (r) { s = r; setSession(r); saveSession(r); }
  }
  const doReq = tok => fetch(REST + path, {
    method,
    headers: {
      apikey: SUPABASE_KEY, Authorization: "Bearer " + tok,
      "Content-Type": "application/json", Prefer: "return=minimal",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let res = await doReq(s.access_token);
  if (res.status === 401) {
    const r = await refreshSession(s);
    if (r) { setSession(r); saveSession(r); res = await doReq(r.access_token); }
  }
  if (!res.ok) throw new Error("Save failed (" + res.status + "). " + (await res.text().catch(() => "")));
  return true;
}

// An authenticated READ (for admin-only tables like the submissions queue).
async function authedGet(session, setSession, path) {
  let s = session;
  if (s && s.expires_at && s.expires_at < Date.now() + 60000) {
    const r = await refreshSession(s); if (r) { s = r; setSession(r); saveSession(r); }
  }
  const doReq = tok => fetch(REST + path, { headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + tok } });
  let res = await doReq(s.access_token);
  if (res.status === 401) {
    const r = await refreshSession(s);
    if (r) { setSession(r); saveSession(r); res = await doReq(r.access_token); }
  }
  if (!res.ok) throw new Error("Load failed (" + res.status + ").");
  return res.json();
}

// Live quotes via the secure edge proxy (signed-in only). Returns { SYMBOL: {c, dp} }.
async function fetchQuotes(session, symbols) {
  if (!session || !symbols || !symbols.length) return { prices: {}, at: null };
  const res = await fetch(FUNCTIONS + "quotes", {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + session.access_token, "Content-Type": "application/json" },
    body: JSON.stringify({ symbols }),
  });
  if (!res.ok) throw new Error("quotes " + res.status);
  return res.json();
}

// Upload any file (photo, PDF, doc…) to the grantee-photos bucket (admin only).
// Returns { url, name, type } so the feed can render images inline and other
// files as a download link.
async function uploadFile(session, file, org) {
  const safe = (org || "grantee").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  const ext = (file.name.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "");
  const path = safe + "/" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + "." + ext;
  const res = await fetch(SUPABASE_URL + "/storage/v1/object/grantee-photos/" + encodeURIComponent(path), {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + session.access_token, "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!res.ok) throw new Error("Upload failed (" + res.status + "). " + (await res.text().catch(() => "")));
  return { url: SUPABASE_URL + "/storage/v1/object/public/grantee-photos/" + path, name: file.name, type: file.type || "" };
}

// ---- private grant paperwork (admin only, never public-by-URL) ----
// Upload into the private grant-docs bucket.
async function uploadPrivateDoc(session, setSession, path, file) {
  const doReq = tok => fetch(SUPABASE_URL + "/storage/v1/object/grant-docs/" + encodeURI(path), {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + tok, "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  let res = await doReq(session.access_token);
  if (res.status === 401) {
    const r = await refreshSession(session);
    if (r) { setSession(r); saveSession(r); res = await doReq(r.access_token); }
  }
  if (!res.ok) throw new Error("Upload failed (" + res.status + "). " + (await res.text().catch(() => "")));
  return true;
}

// Remove a filed document. Storage blocks raw row deletes, so this goes through the API.
async function deletePrivateDoc(session, setSession, path) {
  const doReq = tok => fetch(SUPABASE_URL + "/storage/v1/object/grant-docs/" + encodeURI(path), {
    method: "DELETE",
    headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + tok },
  });
  let res = await doReq(session.access_token);
  if (res.status === 401) {
    const r = await refreshSession(session);
    if (r) { setSession(r); saveSession(r); res = await doReq(r.access_token); }
  }
  if (!res.ok && res.status !== 404) throw new Error("Couldn't remove the file (" + res.status + ").");
  return true;
}

// Short-lived signed link so a private document can be opened without making it public.
async function signedDocUrl(session, setSession, path) {
  const doReq = tok => fetch(SUPABASE_URL + "/storage/v1/object/sign/grant-docs/" + encodeURI(path), {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + tok, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: 300 }),
  });
  let res = await doReq(session.access_token);
  if (res.status === 401) {
    const r = await refreshSession(session);
    if (r) { setSession(r); saveSession(r); res = await doReq(r.access_token); }
  }
  if (!res.ok) throw new Error("Couldn't build a link (" + res.status + ").");
  const j = await res.json();
  return SUPABASE_URL + "/storage/v1" + j.signedURL;
}

// Is this attachment an image? Handles both legacy bare-URL strings and {url,name,type} objects.
function attIsImage(a) {
  if (typeof a === "string") return /\.(png|jpe?g|gif|webp|heic|avif|bmp)$/i.test(a);
  if (a && a.type && a.type.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|heic|avif|bmp)$/i.test((a && (a.url || a.name)) || "");
}
const attUrl = a => (typeof a === "string" ? a : a.url);
const attName = a => (typeof a === "string" ? a.split("/").pop() : (a.name || a.url.split("/").pop()));

// ---- auth context ----
const AuthContext = createContext(null);
const useAuth = () => useContext(AuthContext);

// Pull every display table in parallel and shape it like the fallback data.
async function fetchLiveData(get) {
  const [grants, donations, assets, settings, notes, updates, programs, gifts, gdocs] = await Promise.all([
    get("grants?select=id,year,org,amount,category,check_number,check_date&order=year.desc,amount.desc"),
    get("donations?select=id,year,donor,amount&order=year.desc"),
    get("investment_assets?select=id,name,value,sort_order&order=sort_order"),
    get("settings?select=key,value"),
    get("grantee_notes?select=org,display_name,contact,contact_role,contact_email,website,description,community,note,core_outcomes,mailing_address,phone,ein,legal_name,org_type,irs_status,verified_on,verified_by,verification_source,public_purpose,drive_folder_url"),
    get("grantee_updates?select=id,org,title,body,author,photos,created_at&order=created_at.desc"),
    get("grantee_programs?select=id,org,name,purpose,metrics,sort_order,status&order=sort_order"),
    get("contribution_gifts?select=id,gift_date,donor,donor_formal,donor_greeting,donor_address,amount,gift_type,securities,note,receipt_date&order=gift_date.desc"),
    get("grantee_documents?select=id,org,kind,storage_path,filename,uploaded_at&order=uploaded_at.desc"),
  ]);
  const setMap = Object.fromEntries(settings.map(s => [s.key, s.value]));
  const noteMap = {};
  notes.forEach(n => { noteMap[n.org] = {
    displayName: n.display_name, contact: n.contact, contactRole: n.contact_role,
    contactEmail: n.contact_email, website: n.website, description: n.description,
    community: n.community, note: n.note, mailingAddress: n.mailing_address, phone: n.phone, ein: n.ein,
    legalName: n.legal_name, orgType: n.org_type || "charity", irsStatus: n.irs_status,
    verifiedOn: n.verified_on, verifiedBy: n.verified_by, verificationSource: n.verification_source, publicPurpose: n.public_purpose, driveFolderUrl: n.drive_folder_url,
    coreOutcomes: n.core_outcomes || null,
  }; });
  const updateMap = {};
  updates.forEach(u => {
    (updateMap[u.org] = updateMap[u.org] || []).push({
      id: u.id, title: u.title, body: u.body, author: u.author,
      photos: Array.isArray(u.photos) ? u.photos : [], created_at: u.created_at,
    });
  });
  const programMap = {};
  programs.forEach(p => {
    (programMap[p.org] = programMap[p.org] || []).push({
      id: p.id, name: p.name, purpose: p.purpose, status: p.status, sortOrder: p.sort_order,
      metrics: Array.isArray(p.metrics) ? p.metrics : [],
    });
  });
  const docMap = {};
  (gdocs || []).forEach(d => { (docMap[d.org] = docMap[d.org] || []).push(d); });
  return {
    grants: grants.map(g => ({
      id: g.id, year: Number(g.year), org: g.org, amount: Number(g.amount),
      category: g.category || "Community & Social Services",
      checkNumber: g.check_number || null, checkDate: g.check_date || null,
    })),
    donations: donations.map(d => ({ id: d.id, year: Number(d.year), donor: d.donor, amount: Number(d.amount) })),
    contributionGifts: (gifts || []).map(g => ({
      id: g.id, giftDate: g.gift_date, donor: g.donor, donorFormal: g.donor_formal,
      donorGreeting: g.donor_greeting, donorAddress: g.donor_address,
      amount: Number(g.amount), giftType: g.gift_type,
      securities: Array.isArray(g.securities) ? g.securities : [],
      note: g.note, receiptDate: g.receipt_date,
    })),
    investments: {
      asOf: setMap.as_of || "",
      source: setMap.investment_source || "",
      dividendsInterest: Number(setMap.dividends_interest || 0),
      accounts: Number(setMap.num_accounts || 0),
      composition: assets.map(a => ({ id: a.id, name: a.name, value: Number(a.value) })),
    },
    granteeNotes: noteMap,
    granteeUpdates: updateMap,
    granteePrograms: programMap,
    granteeDocs: docMap,
  };
}

// =============================================================================
//  DATA  Nothing is bundled with the site. Everything loads from Supabase after a
//  family member or advisor signs in, so the public code holds no figures or names.
// =============================================================================

const EMPTY_DATA = {
  grants: [],
  donations: [],
  contributionGifts: [],
  investments: { asOf: "", source: "", dividendsInterest: 0, accounts: 0, composition: [] },
  granteeNotes: {},
  granteeUpdates: {},
  granteePrograms: {},
  granteeDocs: {},
};

const DataContext = createContext(EMPTY_DATA);
const useData = () => useContext(DataContext);

// =============================================================================
//  FORMS  (repoint these to your live Google Form when ready)
//  Leave blank to show a "coming soon" state on the buttons.
// =============================================================================

const GRANT_REQUEST_URL = "";   // e.g. "https://forms.gle/xxxxxxxx"
const CONTRIBUTION_URL  = "";   // e.g. "https://forms.gle/yyyyyyyy"
const DRIVE_URL = "https://drive.google.com/drive/u/0/folders/1CP4Dpt0hDsw2n-3JYW_F8rVo42Nu6aYH";

// =============================================================================
//  CONSTANTS & HELPERS
// =============================================================================

const TEAL = "#0B6E6E";          // anchor
const SOFT_TEAL = "#2FA39B";
const CORAL = "#F2885E";         // warmth
const SUN = "#F4C95D";           // accent
const INK = "#1F3A38";
const PAPER = "#FFF8F2";
const LINE = "#EFE7DD";
const FONT_DISPLAY = "'Fredoka', sans-serif";
const FONT_BODY = "'Nunito Sans', sans-serif";
const FONT_ACCENT = "'Caveat', cursive";

// The shared mission Kendacar holds every youth grantee to — from the brand backbone.
const SHARED_PURPOSE = "Helping every young person make it all the way to adulthood — housed, working or learning, and connected to someone who has their back.";

// The four core outcomes every youth grantee reports against, in the same language.
const CORE_OUTCOMES = [
  { key: "education",  label: "Education",     blurb: "Earned, or on track for, a diploma or GED",  color: "#3E7CB1" },
  { key: "work",       label: "Work or school", blurb: "Employed, or enrolled in school or training", color: "#2FA39B" },
  { key: "housing",    label: "Housing",       blurb: "In stable housing",                           color: "#C77D3A" },
  { key: "connection", label: "Connection",    blurb: "Has at least one steady, caring adult",       color: "#B5577E" },
];
// Categories that carry the shared youth-outcomes framework.
const YOUTH_CATEGORIES = ["Children & Youth"];

// The "hop mark" — a little bounce ending on a coral landing.
function HopMark({ size = 30, light = false }) {
  const dash = light ? "#BFE0DE" : SOFT_TEAL;
  const dot = light ? PAPER : TEAL;
  const land = light ? SUN : CORAL;
  return (
    <svg width={size} height={size} viewBox="0 0 72 72" fill="none" style={{ flexShrink: 0 }}>
      <path d="M8 56 Q22 30 36 40 Q50 50 64 16" stroke={dash} strokeWidth="3" strokeDasharray="2 6" strokeLinecap="round" />
      <circle cx="8" cy="56" r="4.5" fill={dot} />
      <circle cx="36" cy="40" r="5.5" fill={dot} />
      <circle cx="64" cy="16" r="8" fill={land} />
    </svg>
  );
}

// Wordmark: hop mark + lowercase "kendacar" in Fredoka.
function Wordmark({ size = 22, light = false, sub = true }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
      <HopMark size={size * 1.5} light={light} />
      <span style={{ display: "inline-flex", flexDirection: "column", lineHeight: 1 }}>
        <span style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: size, color: light ? PAPER : TEAL, letterSpacing: "-0.5px" }}>kendacar</span>
        {sub && <span style={{ fontFamily: FONT_BODY, fontWeight: 700, fontSize: size * 0.4, letterSpacing: "3px", color: light ? "#BFE0DE" : "#A9968A", marginTop: 2 }}>FOUNDATION</span>}
      </span>
    </span>
  );
}

const CAT_COLORS = {
  "Children & Youth":         "#0B6E6E",
  "Domestic Violence":        "#B5451B",
  "Food & Hunger":            "#C8A020",
  "Healthcare":               "#3A6B9C",
  "Arts & Culture":           "#7B5EA7",
  "Education":                "#2E7D5E",
  "Environment & Wildlife":   "#4A7C59",
  "Community Development":    "#6B8E9F",
  "Community & Social Services": "#8A6B4E",
  "Religious":                "#9E7B5A",
};

const fmt  = n => "$" + Number(n).toLocaleString();
const fmtK = n => n >= 1000000 ? "$" + (n/1000000).toFixed(1) + "M" : n >= 1000 ? "$" + Math.round(n/1000) + "k" : "$" + n;

// Normalize grantee display names so the same org doesn't split into two rows
// (casing + trailing-space variants). Huron Community vs Huron County
// Community Foundation are intentionally left separate.
// The name to show for a grant's organization: legal name, then display name, then the name it's filed under.
function orgLabel(org, notes) {
  const n = notes && (notes[org] || notes[normalizeOrg(org || "")]);
  return (n && (n.legalName || n.displayName)) || org;
}

function normalizeOrg(org) {
  let o = org.trim().replace(/\s+/g, " ");
  if (/^casa of mchenry county$/i.test(o)) return "CASA of McHenry County";
  if (/^options and advocacy for mchenry county$/i.test(o)) return "Options and Advocacy for McHenry County";
  return o;
}

// Derived values — computed from whatever data is current (fallback or live).
const yearOptions = grants => ["All Years", ...Array.from(new Set(grants.map(g => g.year))).sort((a,b) => b-a)];
const orgOptions  = grants => ["All Organizations", ...Array.from(new Set(grants.map(g => g.org))).sort()];
const catOptions  = grants => ["All Categories", ...Array.from(new Set(grants.map(g => g.category))).sort()];
const sumAmount   = rows => rows.reduce((s, r) => s + Number(r.amount), 0);
const corpusTotal = investments => investments.composition.reduce((s, a) => s + Number(a.value), 0);
const currentCycleYear = grants => grants.length ? Math.max(...grants.map(g => g.year)) : new Date().getFullYear();

// =============================================================================
//  HOOKS
// =============================================================================

function useWindowWidth() {
  const [w, setW] = useState(typeof window !== "undefined" ? window.innerWidth : 1200);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}

// =============================================================================
//  SHARED COMPONENTS
// =============================================================================

function StatCard({ label, value, sub, accent }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #EFE7DD", borderRadius: 18, padding: "20px 24px", borderTop: "3px solid " + (accent || TEAL) }}>
      <div style={{ fontSize: 11, fontFamily: FONT_BODY, fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase", color: "#7C8C8A", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 30, fontWeight: 600, color: "#1F3A38", fontFamily: FONT_DISPLAY, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: "#7C8C8A", marginTop: 4, fontFamily: "'Nunito Sans', sans-serif" }}>{sub}</div>}
    </div>
  );
}

function FilterSelect({ label, value, onChange, options }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label style={{ fontSize: 10, fontFamily: "'Fredoka', serif", letterSpacing: "0.1em", textTransform: "uppercase", color: "#7C8C8A" }}>{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)} style={{
        border: "1px solid #E2D7C9", borderRadius: 6, padding: "7px 28px 7px 10px", fontSize: 13,
        fontFamily: "'Nunito Sans', sans-serif", color: "#1F3A38", background: "#FBF4EC", appearance: "none",
        backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%235A8080'/%3E%3C/svg%3E\")",
        backgroundRepeat: "no-repeat", backgroundPosition: "right 10px center", cursor: "pointer", minWidth: 180,
      }}>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#fff", border: "1px solid #EFE7DD", borderRadius: 8, padding: "10px 14px", fontSize: 13, fontFamily: "'Nunito Sans', sans-serif", boxShadow: "0 4px 12px rgba(0,0,0,0.08)" }}>
      <div style={{ fontWeight: 600, marginBottom: 4, color: "#1F3A38" }}>{label}</div>
      {payload.map((p, i) => <div key={i} style={{ color: p.color || TEAL }}>{fmt(p.value)}</div>)}
    </div>
  );
};

function Card({ children, style }) {
  return <div style={{ background: "#fff", border: "1px solid #EFE7DD", borderRadius: 18, ...style }}>{children}</div>;
}

function SectionTitle({ title, sub }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 28, color: "#1F3A38", lineHeight: 1.1 }}>{title}</div>
      {sub && <div style={{ fontSize: 13.5, color: "#7C8C8A", marginTop: 6, fontFamily: FONT_BODY }}>{sub}</div>}
    </div>
  );
}

function PrimaryButton({ href, children, disabled }) {
  const base = {
    display: "inline-block", padding: "11px 22px", borderRadius: 8, fontSize: 14,
    fontFamily: "'Nunito Sans', sans-serif", fontWeight: 600, textDecoration: "none", letterSpacing: "0.02em",
    border: "1px solid " + TEAL, cursor: disabled ? "default" : "pointer", transition: "all .15s",
  };
  if (disabled || !href) {
    return <span style={{ ...base, background: "#F3ECE3", color: "#7C8C8A", borderColor: "#EFE7DD" }}
      title="Add your Google Form link in App.jsx to enable">{children} <span style={{ fontSize: 11 }}>(link coming)</span></span>;
  }
  return <a href={href} target="_blank" rel="noopener noreferrer" style={{ ...base, background: TEAL, color: "#fff" }}>{children}</a>;
}

// =============================================================================
//  EDITING UI  (only rendered when an approved person is signed in)
// =============================================================================

const CATEGORY_LIST = Object.keys(CAT_COLORS);

const inputStyle = {
  border: "1px solid #E2D7C9", borderRadius: 6, padding: "6px 8px", fontSize: 13,
  fontFamily: "'Nunito Sans', sans-serif", color: "#1F3A38", background: "#fff", width: "100%",
};

function EdInput({ value, onChange, type = "text", placeholder, list }) {
  return <input type={type} value={value} placeholder={placeholder} list={list}
    onChange={e => onChange(e.target.value)} style={inputStyle} />;
}
function EdSelect({ value, onChange, options }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)} style={{ ...inputStyle, cursor: "pointer" }}>
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

function MiniButton({ onClick, children, kind, disabled, title }) {
  const colors = {
    save:   { bg: TEAL, fg: "#fff", bd: TEAL },
    cancel: { bg: "#fff", fg: "#7C8C8A", bd: "#E2D7C9" },
    delete: { bg: "#fff", fg: "#B5451B", bd: "#E3C3B6" },
    edit:   { bg: "#FBF4EC", fg: TEAL, bd: "#EFE7DD" },
  }[kind] || { bg: "#fff", fg: TEAL, bd: "#E2D7C9" };
  return (
    <button onClick={onClick} disabled={disabled} title={title} style={{
      background: colors.bg, color: colors.fg, border: "1px solid " + colors.bd, borderRadius: 6,
      padding: "5px 11px", fontSize: 12, fontWeight: 600, cursor: disabled ? "default" : "pointer",
      opacity: disabled ? 0.5 : 1, fontFamily: "'Nunito Sans', sans-serif",
    }}>{children}</button>
  );
}

// Inline editor for a single grant row (id null => adding a new grant).
function GrantEditRow({ row, onDone, narrow }) {
  const { session, setSession } = useAuth();
  const { refresh, grants: allGrants, granteeNotes: allNotes } = useData();
  const orgListId = "kc-orgs-" + (row?.id ?? "new");
  const orgNames = useMemo(() => [...new Set([...Object.keys(allNotes || {}), ...(allGrants || []).map(g => g.org)])].sort(), [allGrants, allNotes]);
  const [year, setYear] = useState(row?.year ?? new Date().getFullYear());
  const [org, setOrg] = useState(row?.org ?? "");
  const [amount, setAmount] = useState(row?.amount ?? "");
  const [category, setCategory] = useState(row?.category ?? CATEGORY_LIST[0]);
  const [checkDate, setCheckDate] = useState(row?.checkDate ?? "");
  const [checkNumber, setCheckNumber] = useState(row?.checkNumber ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function save() {
    if (!org.trim() || amount === "" || isNaN(Number(amount)) || isNaN(Number(year))) {
      setErr("Year, organization and a numeric amount are required."); return;
    }
    setBusy(true); setErr("");
    const payload = { year: Number(year), org: org.trim(), amount: Number(amount), category, check_date: checkDate || null, check_number: String(checkNumber).trim() || null };
    try {
      if (row?.id != null) await authedWrite(session, setSession, "PATCH", "grants?id=eq." + row.id, payload);
      else await authedWrite(session, setSession, "POST", "grants", payload);
      await refresh(); onDone();
    } catch (e) { setErr(e.message); setBusy(false); }
  }
  async function remove() {
    if (!window.confirm("Delete this grant? This can't be undone.")) return;
    setBusy(true); setErr("");
    try { await authedWrite(session, setSession, "DELETE", "grants?id=eq." + row.id); await refresh(); onDone(); }
    catch (e) { setErr(e.message); setBusy(false); }
  }

  return (
    <tr style={{ background: "#F0FAFA", borderBottom: "1px solid #EFE7DD" }}>
      <td style={{ padding: "8px 12px" }}><EdInput type="number" value={year} onChange={setYear} /></td>
      <td style={{ padding: "8px 12px" }}><EdInput value={org} onChange={setOrg} placeholder="Organization" list={orgListId} />
        <datalist id={orgListId}>{orgNames.map(n => <option key={n} value={n} />)}</datalist></td>
      <td style={{ padding: "8px 12px" }}><EdSelect value={category} onChange={setCategory} options={CATEGORY_LIST} /></td>
      <td style={{ padding: "8px 12px" }}><EdInput type="number" value={amount} onChange={setAmount} placeholder="Amount" /></td>
      <td style={{ padding: "8px 12px" }}><EdInput type="date" value={checkDate} onChange={setCheckDate} /></td>
      <td style={{ padding: "8px 12px" }}><EdInput value={checkNumber} onChange={setCheckNumber} placeholder="Check #" /></td>
      <td style={{ padding: "8px 12px" }} />
      <td style={{ padding: "8px 28px 8px 12px", whiteSpace: "nowrap" }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <MiniButton kind="save" onClick={save} disabled={busy}>{busy ? "…" : "Save"}</MiniButton>
          <MiniButton kind="cancel" onClick={onDone} disabled={busy}>Cancel</MiniButton>
          {row?.id != null && <MiniButton kind="delete" onClick={remove} disabled={busy}>Delete</MiniButton>}
        </div>
        {err && <div style={{ color: "#B5451B", fontSize: 11, marginTop: 4, maxWidth: 240 }}>{err}</div>}
      </td>
    </tr>
  );
}

// Inline editor for a single donation row.
function DonationEditRow({ row, onDone }) {
  const { session, setSession } = useAuth();
  const { refresh } = useData();
  const [year, setYear] = useState(row?.year ?? new Date().getFullYear());
  const [donor, setDonor] = useState(row?.donor ?? "");
  const [amount, setAmount] = useState(row?.amount ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function save() {
    if (!donor.trim() || amount === "" || isNaN(Number(amount)) || isNaN(Number(year))) {
      setErr("Year, donor and a numeric amount are required."); return;
    }
    setBusy(true); setErr("");
    const payload = { year: Number(year), donor: donor.trim(), amount: Number(amount) };
    try {
      if (row?.id != null) await authedWrite(session, setSession, "PATCH", "donations?id=eq." + row.id, payload);
      else await authedWrite(session, setSession, "POST", "donations", payload);
      await refresh(); onDone();
    } catch (e) { setErr(e.message); setBusy(false); }
  }
  async function remove() {
    if (!window.confirm("Delete this contribution?")) return;
    setBusy(true); setErr("");
    try { await authedWrite(session, setSession, "DELETE", "donations?id=eq." + row.id); await refresh(); onDone(); }
    catch (e) { setErr(e.message); setBusy(false); }
  }

  return (
    <tr style={{ background: "#F0FAFA", borderBottom: "1px solid #EFE7DD" }}>
      <td style={{ padding: "8px 12px" }}><EdInput type="number" value={year} onChange={setYear} /></td>
      <td style={{ padding: "8px 12px" }}><EdInput value={donor} onChange={setDonor} placeholder="Donor" /></td>
      <td style={{ padding: "8px 12px" }}><EdInput type="number" value={amount} onChange={setAmount} placeholder="Amount" /></td>
      <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <MiniButton kind="save" onClick={save} disabled={busy}>{busy ? "…" : "Save"}</MiniButton>
          <MiniButton kind="cancel" onClick={onDone} disabled={busy}>Cancel</MiniButton>
          {row?.id != null && <MiniButton kind="delete" onClick={remove} disabled={busy}>Delete</MiniButton>}
        </div>
        {err && <div style={{ color: "#B5451B", fontSize: 11, marginTop: 4 }}>{err}</div>}
      </td>
    </tr>
  );
}

// Footer sign-in / sign-out control.
const PASSWORD_MIN = 8;

// Sign in with email and password. First-timers create a password (one confirmation email);
// anyone who forgets gets a reset link.
function SignInPanel() {
  const { signIn, createPassword, sendPasswordReset } = useAuth();
  const [mode, setMode] = useState("signin"); // signin | create | forgot | confirm-sent | reset-sent
  const [addr, setAddr] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const email = () => addr.trim().toLowerCase();
  const go = next => { setMode(next); setMsg(""); setPw(""); setPw2(""); };

  async function run(e, fn) {
    e.preventDefault();
    if (!email()) { setMsg("Enter your email address."); return; }
    setBusy(true); setMsg("");
    try { await fn(); } catch (err) { setMsg(err.message); } finally { setBusy(false); }
  }
  const doSignIn = e => run(e, async () => {
    if (!pw) throw new Error("Enter your password.");
    await signIn(email(), pw);
  });
  const doCreate = e => run(e, async () => {
    if (pw.length < PASSWORD_MIN) throw new Error("Use at least " + PASSWORD_MIN + " characters.");
    if (pw !== pw2) throw new Error("The two passwords don't match.");
    const session = await createPassword(email(), pw);
    if (!session) go("confirm-sent");
  });
  const doForgot = e => run(e, async () => { await sendPasswordReset(email()); go("reset-sent"); });

  const field = { ...formInput, fontSize: 15 };
  const primary = { width: "100%", background: TEAL, color: "#fff", border: "none", borderRadius: 12, padding: "13px 22px",
    fontSize: 15, fontWeight: 700, fontFamily: FONT_BODY, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 };
  const quiet = { background: "none", border: "none", padding: 0, color: TEAL, cursor: "pointer", fontWeight: 700, fontSize: 12.5, fontFamily: FONT_BODY };
  const note = { fontSize: 14, color: "#5E6E6C", fontFamily: FONT_BODY, lineHeight: 1.6 };
  const error = msg && <div style={{ color: "#B5451B", fontSize: 13, marginBottom: 12, fontFamily: FONT_BODY }}>{msg}</div>;
  const emailField = (
    <FormField label="Email">
      <input type="email" autoComplete="email" value={addr} onChange={e => setAddr(e.target.value)} placeholder="you@example.com" style={field} />
    </FormField>
  );

  if (mode === "confirm-sent" || mode === "reset-sent") {
    return (
      <div>
        <p style={note}>
          {mode === "confirm-sent"
            ? <>Almost done. We sent a confirmation link to <strong style={{ color: INK }}>{email()}</strong>. Click it once and you're in; after that, just sign in with your password.</>
            : <>If <strong style={{ color: INK }}>{email()}</strong> has a Kendacar password, a link to reset it is on its way.</>}
        </p>
        <button type="button" style={{ ...quiet, marginTop: 14 }} onClick={() => go("signin")}>Back to sign in</button>
      </div>
    );
  }
  if (mode === "create") {
    return (
      <form onSubmit={doCreate}>
        <p style={{ ...note, marginBottom: 14 }}>Choose a password for your Kendacar sign-in. We'll email you once to confirm it's you.</p>
        {emailField}
        <FormField label="Password" hint={"At least " + PASSWORD_MIN + " characters"}>
          <input type="password" autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} style={field} />
        </FormField>
        <FormField label="Password again">
          <input type="password" autoComplete="new-password" value={pw2} onChange={e => setPw2(e.target.value)} style={field} />
        </FormField>
        {error}
        <button type="submit" disabled={busy} style={primary}>{busy ? "Saving…" : "Create my password"}</button>
        <button type="button" style={{ ...quiet, marginTop: 14 }} onClick={() => go("signin")}>I already have a password</button>
      </form>
    );
  }
  if (mode === "forgot") {
    return (
      <form onSubmit={doForgot}>
        <p style={{ ...note, marginBottom: 14 }}>Enter your email and we'll send a link to choose a new password.</p>
        {emailField}
        {error}
        <button type="submit" disabled={busy} style={primary}>{busy ? "Sending…" : "Email me a reset link"}</button>
        <button type="button" style={{ ...quiet, marginTop: 14 }} onClick={() => go("signin")}>Back to sign in</button>
      </form>
    );
  }
  return (
    <form onSubmit={doSignIn}>
      {emailField}
      <FormField label="Password">
        <input type="password" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} style={field} />
      </FormField>
      {error}
      <button type="submit" disabled={busy} style={primary}>{busy ? "Signing in…" : "Sign in"}</button>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginTop: 14, flexWrap: "wrap" }}>
        <button type="button" style={quiet} onClick={() => go("create")}>First time? Create your password</button>
        <button type="button" style={quiet} onClick={() => go("forgot")}>Forgot password?</button>
      </div>
    </form>
  );
}

// Shown after following a reset link: choose the new password, then carry on into the site.
function SetPasswordScreen() {
  const { savePassword, email } = useAuth();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  async function submit(e) {
    e.preventDefault();
    if (pw.length < PASSWORD_MIN) { setMsg("Use at least " + PASSWORD_MIN + " characters."); return; }
    if (pw !== pw2) { setMsg("The two passwords don't match."); return; }
    setBusy(true); setMsg("");
    try { await savePassword(pw); } catch (err) { setMsg(err.message); setBusy(false); }
  }
  return (
    <NoticeScreen title="Choose a new password" body={"For " + email}>
      <form onSubmit={submit} style={{ width: "100%", textAlign: "left" }}>
        <FormField label="New password" hint={"At least " + PASSWORD_MIN + " characters"}>
          <input type="password" autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} style={formInput} />
        </FormField>
        <FormField label="New password again">
          <input type="password" autoComplete="new-password" value={pw2} onChange={e => setPw2(e.target.value)} style={formInput} />
        </FormField>
        {msg && <div style={{ color: "#B5451B", fontSize: 13, marginBottom: 12 }}>{msg}</div>}
        <button type="submit" disabled={busy} style={{ width: "100%", background: TEAL, color: "#fff", border: "none", borderRadius: 12, padding: "12px 22px", fontSize: 15, fontWeight: 700, fontFamily: FONT_BODY, cursor: "pointer", opacity: busy ? 0.6 : 1 }}>
          {busy ? "Saving…" : "Save and continue"}
        </button>
      </form>
    </NoticeScreen>
  );
}

// =============================================================================
//  WELCOME  (the only page anyone can see without signing in)
// =============================================================================

// Inquiries go to Netlify Forms, which filters spam and emails the foundation, so the
// database never accepts anything from someone who isn't signed in.
function InquiryForm() {
  const [f, setF] = useState({ name: "", email: "", organization: "", message: "", company_website: "" });
  const [state, setState] = useState("idle"); // idle | sending | sent | missing | error
  const set = (k, v) => setF({ ...f, [k]: v });

  async function submit(e) {
    e.preventDefault();
    if (!f.name.trim() || !f.email.trim() || !f.message.trim()) { setState("missing"); return; }
    setState("sending");
    try {
      const body = new URLSearchParams({ "form-name": "inquiry", ...f }).toString();
      const res = await fetch("/", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
      if (!res.ok) throw new Error(String(res.status));
      setState("sent");
    } catch { setState("error"); }
  }

  if (state === "sent") {
    return <div style={{ fontFamily: FONT_BODY, fontSize: 15, color: TEAL, lineHeight: 1.6, padding: "8px 0" }}>Thank you. Your note has been sent, and we'll be in touch.</div>;
  }
  return (
    <form name="inquiry" onSubmit={submit} style={{ position: "relative" }}>
      {/* Honeypot: people never see or fill this; bots do, and Netlify discards those submissions. */}
      <p aria-hidden="true" style={{ position: "absolute", left: "-10000px", width: 1, height: 1, overflow: "hidden" }}>
        <label>Leave this empty <input name="company_website" tabIndex={-1} autoComplete="off" value={f.company_website} onChange={e => set("company_website", e.target.value)} /></label>
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <FormField label="Your name"><input value={f.name} onChange={e => set("name", e.target.value)} style={formInput} /></FormField>
        <FormField label="Email"><input type="email" value={f.email} onChange={e => set("email", e.target.value)} style={formInput} /></FormField>
      </div>
      <FormField label="Organization" hint="Optional"><input value={f.organization} onChange={e => set("organization", e.target.value)} style={formInput} /></FormField>
      <FormField label="Message"><textarea rows={4} value={f.message} onChange={e => set("message", e.target.value)} style={{ ...formInput, resize: "vertical" }} /></FormField>
      {state === "missing" && <div style={{ color: "#B5451B", fontSize: 13, marginBottom: 12, fontFamily: FONT_BODY }}>Please add your name, email and a message.</div>}
      {state === "error" && <div style={{ color: "#B5451B", fontSize: 13, marginBottom: 12, fontFamily: FONT_BODY }}>We couldn't send that just now. Please write to us at the address above.</div>}
      <button type="submit" disabled={state === "sending"} style={{ background: CORAL, color: "#fff", border: "none", borderRadius: 12, padding: "12px 24px", fontSize: 15, fontWeight: 700, fontFamily: FONT_BODY, cursor: "pointer", opacity: state === "sending" ? 0.6 : 1 }}>
        {state === "sending" ? "Sending…" : "Send"}
      </button>
    </form>
  );
}

function WelcomePage({ narrow }) {
  const card = { background: "#fff", border: "1.5px solid " + LINE, borderRadius: 24, padding: narrow ? "26px 22px" : "34px 38px" };
  const eyebrow = { fontFamily: FONT_BODY, fontWeight: 800, fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: "#7C8C8A", marginBottom: 8 };
  return (
    <div style={{ minHeight: "100vh", background: "#FFF8F2", fontFamily: FONT_BODY, color: INK }}>
      <div style={{ background: "linear-gradient(135deg, #0B6E6E 0%, #0A5C5C 100%)", color: "#fff", padding: narrow ? "40px 20px 56px" : "64px 40px 80px" }}>
        <div style={{ maxWidth: 1040, margin: "0 auto" }}>
          <Wordmark size={narrow ? 26 : 32} light sub={false} />
          <h1 style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: narrow ? 30 : 42, lineHeight: 1.15, margin: "26px 0 10px", maxWidth: 680 }}>A family foundation, giving since 2001.</h1>
          <p style={{ fontSize: narrow ? 15 : 17, color: "#CFEFE5", lineHeight: 1.6, maxWidth: 620 }}>The Kendacar Foundation supports community organizations serving children, families and the places we call home.</p>
        </div>
      </div>
      <div style={{ maxWidth: 1040, margin: narrow ? "-28px auto 0" : "-44px auto 0", padding: narrow ? "0 16px 48px" : "0 40px 72px", display: "grid", gridTemplateColumns: narrow ? "1fr" : "minmax(0,1.35fr) minmax(0,1fr)", gap: 22, alignItems: "start" }}>
        <div style={card}>
          <div style={eyebrow}>Contact the foundation</div>
          <div style={{ fontSize: 15, lineHeight: 1.6, marginBottom: 22 }}>
            <strong>Kendacar Foundation, Inc.</strong><br />627 Leonard Pkwy.<br />Crystal Lake, IL 60014
          </div>
          <InquiryForm />
        </div>
        <div style={card}>
          <div style={eyebrow}>Family &amp; advisors</div>
          <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 22, marginBottom: 6 }}>Sign in</div>
          <p style={{ fontSize: 14, color: "#6F7E7C", lineHeight: 1.55, marginBottom: 18 }}>Sign in with your email and Kendacar password.</p>
          <SignInPanel />
        </div>
      </div>
      <div style={{ padding: "0 20px 36px", textAlign: "center", fontSize: 11, color: "#9B8E80", fontFamily: FONT_DISPLAY, letterSpacing: "0.08em" }}>KENDACAR FOUNDATION</div>
    </div>
  );
}

function NoticeScreen({ title, body, children }) {
  return (
    <div style={{ minHeight: "100vh", background: "#FFF8F2", display: "grid", placeItems: "center", padding: 24, fontFamily: FONT_BODY }}>
      <div style={{ maxWidth: 460, textAlign: "center", background: "#fff", border: "1.5px solid " + LINE, borderRadius: 24, padding: "34px 30px" }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}><HopMark size={46} /></div>
        <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 22, color: INK, marginBottom: 8 }}>{title}</div>
        {body && <div style={{ fontSize: 14.5, color: "#6F7E7C", lineHeight: 1.6 }}>{body}</div>}
        {children && <div style={{ marginTop: 18, display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>{children}</div>}
      </div>
    </div>
  );
}

// =============================================================================
//  NAV BAR
// =============================================================================

function NavBar({ view, setView, narrow, signedIn, pending }) {
  const items = [
    { id: "pulse",         label: "Pulse" },
    { id: "investments",   label: "Investments" },
    { id: "grants",        label: "Grants Made" },
    { id: "contributions", label: "Contributions" },
    { id: "grantees",      label: "Grantees" },
  ];
  // Trustees get the submissions queue as a first-class tab, with a count of what's waiting.
  if (signedIn) items.push({ id: "queue", label: "Review", badge: pending });
  const active = view === "grantee-detail" ? "grantees" : view;
  return (
    <div style={{ background: TEAL, color: "#fff", position: "sticky", top: 0, zIndex: 50, boxShadow: "0 2px 8px rgba(0,0,0,0.12)" }}>
      <div style={{ maxWidth: 1140, margin: "0 auto", padding: narrow ? "0 16px" : "0 40px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <button onClick={() => setView("pulse")} style={{ background: "none", border: "none", cursor: "pointer", padding: "12px 0", display: "flex", alignItems: "center" }}>
          <Wordmark size={21} light sub={false} />
        </button>
        <div style={{ display: "flex", gap: narrow ? 2 : 6, flexWrap: "wrap", alignItems: "center" }}>
          {items.map(it => (
            <button key={it.id} onClick={() => setView(it.id)} style={{
              background: active === it.id ? "rgba(255,255,255,0.16)" : "none",
              border: "none", color: active === it.id ? "#fff" : "#BFE0DE",
              fontFamily: "'Nunito Sans', sans-serif", fontWeight: active === it.id ? 600 : 400,
              fontSize: 13, padding: narrow ? "10px 9px" : "10px 14px", borderRadius: 6, cursor: "pointer",
            }}>
              {it.label}
              {it.badge > 0 && (
                <span style={{ background: CORAL, color: "#fff", borderRadius: 20, padding: "1px 7px", fontSize: 10.5, fontWeight: 800, marginLeft: 6 }}>{it.badge}</span>
              )}
            </button>
          ))}
          <a href={DRIVE_URL} target="_blank" rel="noopener noreferrer" title="Open the Kendacar Google Drive" style={{
            display: "inline-flex", alignItems: "center", gap: 5, textDecoration: "none",
            color: "#BFE0DE", fontFamily: "'Nunito Sans', sans-serif", fontWeight: 400,
            fontSize: 13, padding: narrow ? "10px 9px" : "10px 14px", borderRadius: 6,
          }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
            Drive
          </a>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
//  PULSE LANDING
// =============================================================================

function FlowNode({ label, value, sub, big }) {
  return (
    <div style={{ flex: 1, minWidth: 150, textAlign: "center" }}>
      <div style={{ fontSize: 11, fontFamily: "'Fredoka', serif", letterSpacing: "0.14em", textTransform: "uppercase", color: "#BFE0DE", marginBottom: 8 }}>{label}</div>
      <div style={{ fontFamily: "'Fredoka', serif", fontWeight: 700, fontSize: big ? 46 : 34, color: "#fff", lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: "#BFE0DE", marginTop: 8 }}>{sub}</div>}
    </div>
  );
}

function PulseLanding({ setView, goGrantee, narrow }) {
  const { grants, donations, investments, granteeNotes } = useData();
  const { signedIn } = useAuth();
  const cycleYear = currentCycleYear(grants);
  const totalGranted = sumAmount(grants);
  const totalReceived = sumAmount(donations);
  const corpus = corpusTotal(investments);
  const cycleGrants = grants.filter(g => g.year === cycleYear).sort((a, b) => b.amount - a.amount);
  const cycleTotal = cycleGrants.reduce((s, g) => s + g.amount, 0);

  const explore = [
    { id: "investments",   title: "Investments",   desc: corpus ? fmtK(corpus) + " endowment corpus" : "The endowment corpus", accent: "#3A6B9C" },
    { id: "grants",        title: "Grants Made",    desc: fmt(totalGranted) + " across " + grants.length + " grants", accent: TEAL },
    { id: "contributions", title: "Contributions",  desc: fmt(totalReceived) + " given into the fund", accent: "#C8A020" },
    { id: "grantees",      title: "Grantees",       desc: "Every organization, ranked by support", accent: "#7B5EA7" },
  ];

  return (
    <div>
      {/* Hero story flow */}
      <div style={{ background: "linear-gradient(135deg, #0B6E6E 0%, #0A5C5C 100%)", color: "#fff", padding: narrow ? "40px 20px 48px" : "56px 40px 60px" }}>
        <div style={{ maxWidth: 1040, margin: "0 auto" }}>
          <div style={{ fontSize: 12, letterSpacing: "0.2em", textTransform: "uppercase", color: "#BFE0DE", marginBottom: 8, fontFamily: FONT_BODY, fontWeight: 800 }}>Family Philanthropy &middot; Since 2001</div>
          <div style={{ fontFamily: FONT_ACCENT, fontWeight: 700, fontSize: narrow ? 34 : 44, color: SUN, lineHeight: 1, marginBottom: 4 }}>All the way through.</div>
          <h1 style={{ margin: 0, fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: narrow ? 30 : 40, lineHeight: 1.12, maxWidth: 780 }}>
            Helping local kids make it all the way to adulthood.
          </h1>
          <p style={{ color: "#DCEFEC", fontSize: 15.5, marginTop: 14, maxWidth: 640, lineHeight: 1.6, fontFamily: FONT_BODY }}>
            Kendacar gives quietly to the communities it calls home — backing the organizations that keep those places whole, and standing by the older teens stepping into adulthood. The family gives in, the corpus grows, and each year a portion goes out.
          </p>

          {signedIn && (
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 26 }}>
              <button onClick={() => setView("request-grant")} style={{ background: CORAL, color: "#fff", border: "none", borderRadius: 14, padding: narrow ? "14px 22px" : "16px 30px", fontSize: narrow ? 15.5 : 17, fontWeight: 800, fontFamily: FONT_BODY, cursor: "pointer", boxShadow: "0 6px 18px rgba(0,0,0,0.18)", textAlign: "left" }}>
                Recommend a Grant →
                <div style={{ fontSize: 12.5, fontWeight: 600, opacity: 0.9, marginTop: 2 }}>Suggest an organization for a gift</div>
              </button>
              <button onClick={() => setView("contribute")} style={{ background: "#fff", color: TEAL, border: "none", borderRadius: 14, padding: narrow ? "14px 22px" : "16px 30px", fontSize: narrow ? 15.5 : 17, fontWeight: 800, fontFamily: FONT_BODY, cursor: "pointer", boxShadow: "0 6px 18px rgba(0,0,0,0.18)", textAlign: "left" }}>
                Make a Contribution →
                <div style={{ fontSize: 12.5, fontWeight: 600, color: "#5E7C7A", marginTop: 2 }}>Record a gift into the foundation</div>
              </button>
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: narrow ? 4 : 16, marginTop: 40, flexWrap: narrow ? "wrap" : "nowrap" }}>
            <FlowNode label="Contributed In" value={fmtK(totalReceived)} sub="since 2000" />
            <div style={{ fontSize: 28, color: "#5FA3A3", padding: narrow ? "0 4px" : "0 8px" }}>&rarr;</div>
            <FlowNode label="Corpus Today" value={fmtK(corpus)} sub={"as of " + investments.asOf} big />
            <div style={{ fontSize: 28, color: "#5FA3A3", padding: narrow ? "0 4px" : "0 8px" }}>&rarr;</div>
            <FlowNode label="Granted Out" value={fmtK(totalGranted)} sub="all-time" />
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1140, margin: "0 auto", padding: narrow ? "28px 16px" : "36px 40px" }}>
        {/* Current giving cycle */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
          <SectionTitle title={cycleYear + " Giving Cycle"} sub={cycleGrants.length + " grants · " + fmt(cycleTotal) + " committed this cycle"} />
          <button onClick={() => setView("grants")} style={{ background: "none", border: "none", color: TEAL, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "'Nunito Sans', sans-serif" }}>View all grants &rarr;</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: narrow ? "1fr" : "repeat(auto-fill, minmax(210px, 1fr))", gap: 14, marginBottom: 40 }}>
          {cycleGrants.map((g, i) => {
            const c = CAT_COLORS[g.category] || "#999";
            return (
              <button key={g.org + i} onClick={() => goGrantee(normalizeOrg(g.org))} style={{
                textAlign: "left", background: "#fff", border: "1px solid #EFE7DD", borderLeft: "4px solid " + c,
                borderRadius: 10, padding: "16px 18px", cursor: "pointer", fontFamily: "'Nunito Sans', sans-serif",
              }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#1F3A38", marginBottom: 8, lineHeight: 1.25 }}>{orgLabel(g.org, granteeNotes)}</div>
                <div style={{ fontFamily: "'Fredoka', serif", fontWeight: 700, fontSize: 24, color: TEAL }}>{fmt(g.amount)}</div>
                <div style={{ fontSize: 11, color: c, marginTop: 8, fontWeight: 600 }}>{g.category} &rarr;</div>
              </button>
            );
          })}
        </div>


        {/* Explore cards */}
        <SectionTitle title="Explore" sub="Dive into any part of the foundation" />
        <div style={{ display: "grid", gridTemplateColumns: narrow ? "1fr" : "repeat(auto-fill, minmax(240px, 1fr))", gap: 16 }}>
          {explore.map(e => (
            <button key={e.id} onClick={() => setView(e.id)} style={{
              textAlign: "left", background: "#fff", border: "1px solid #EFE7DD", borderTop: "3px solid " + e.accent,
              borderRadius: 12, padding: "22px 24px", cursor: "pointer", fontFamily: "'Nunito Sans', sans-serif",
            }}>
              <div style={{ fontFamily: "'Fredoka', serif", fontWeight: 700, fontSize: 22, color: "#1F3A38", marginBottom: 6 }}>{e.title}</div>
              <div style={{ fontSize: 13, color: "#7C8C8A", lineHeight: 1.45 }}>{e.desc}</div>
              <div style={{ fontSize: 13, color: e.accent, marginTop: 14, fontWeight: 600 }}>Open &rarr;</div>
            </button>
          ))}
        </div>

      </div>
    </div>
  );
}

// =============================================================================
//  INVESTMENTS VIEW
// =============================================================================

function InvestmentEditor({ investments, onDone }) {
  const { session, setSession } = useAuth();
  const { refresh } = useData();
  const [assets, setAssets] = useState(investments.composition.map(a => ({ ...a })));
  const [asOf, setAsOf] = useState(investments.asOf);
  const [accounts, setAccounts] = useState(investments.accounts || 0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function save() {
    setBusy(true); setErr("");
    try {
      for (const a of assets) {
        if (a.id != null) await authedWrite(session, setSession, "PATCH", "investment_assets?id=eq." + a.id, { value: Number(a.value) });
      }
      await authedWrite(session, setSession, "PATCH", "settings?key=eq.as_of", { value: asOf });
      await authedWrite(session, setSession, "PATCH", "settings?key=eq.num_accounts", { value: String(accounts) });
      await refresh(); onDone();
    } catch (e) { setErr(e.message); setBusy(false); }
  }

  return (
    <Card style={{ padding: 22, marginBottom: 24, background: "#FBF4EC" }}>
      <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 18, marginBottom: 4 }}>Update investment figures</div>
      <div style={{ fontSize: 12, color: "#9B8E80", marginBottom: 14 }}>Enter the value per asset class — the total updates automatically.</div>
      <div style={{ display: "grid", gridTemplateColumns: narrow720() ? "1fr" : "repeat(2,1fr)", gap: 12, marginBottom: 14, maxWidth: 560 }}>
        {assets.map((a, i) => (
          <div key={a.id ?? i}>
            <label style={{ fontSize: 12, color: "#7C8C8A", display: "block", marginBottom: 4, fontWeight: 700 }}>{a.name} ($)</label>
            <EdInput type="number" value={a.value} onChange={v => setAssets(assets.map((x, j) => j === i ? { ...x, value: v } : x))} />
          </div>
        ))}
        <div>
          <label style={{ fontSize: 12, color: "#7C8C8A", display: "block", marginBottom: 4, fontWeight: 700 }}># of accounts</label>
          <EdInput type="number" value={accounts} onChange={setAccounts} />
        </div>
        <div>
          <label style={{ fontSize: 12, color: "#7C8C8A", display: "block", marginBottom: 4, fontWeight: 700 }}>As of</label>
          <EdInput value={asOf} onChange={setAsOf} />
        </div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <MiniButton kind="save" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save figures"}</MiniButton>
        <MiniButton kind="cancel" onClick={onDone} disabled={busy}>Cancel</MiniButton>
      </div>
      {err && <div style={{ color: "#B5451B", fontSize: 12, marginTop: 8 }}>{err}</div>}
    </Card>
  );
}
function narrow720() { return typeof window !== "undefined" && window.innerWidth < 720; }

// Gain/loss coloring + formatting helpers for holdings.
const gainColor = v => v == null ? "#7C8C8A" : Number(v) >= 0 ? "#1F7A52" : "#B5451B";
const signed = v => (Number(v) >= 0 ? "+" : "") + fmt(Math.abs(Number(v)) * (Number(v) < 0 ? -1 : 1));

// The hover detail card for a single holding.
function HoldingDetailCard({ h, align }) {
  return (
    <div style={{ position: "absolute", zIndex: 40, top: "100%", [align === "right" ? "right" : "left"]: 0, marginTop: 6, width: 268, background: "#fff", border: "1px solid " + LINE, borderRadius: 12, boxShadow: "0 8px 24px rgba(0,0,0,0.16)", padding: "13px 15px", whiteSpace: "normal", fontWeight: 400, textAlign: "left", cursor: "default" }}>
      <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 14, color: INK }}>{h.symbol}</div>
      <div style={{ fontSize: 12, color: "#7C8C8A", marginBottom: 8 }}>{h.description}</div>
      {[["Quantity", h.qty != null ? Number(h.qty).toLocaleString() : "—"],
        ["Price", h.price != null ? fmt(h.price) : "—"],
        ["Market value", h.market_value != null ? fmt(h.market_value) : "—"],
        ["Cost basis", h.cost_basis != null ? fmt(h.cost_basis) : "—"],
        ["Gain / loss", h.gain != null ? signed(h.gain) + (h.gain_pct != null ? " (" + Number(h.gain_pct).toFixed(1) + "%)" : "") : "—"],
        ["Asset type", h.asset_type || "—"],
        ["Sector", h.sector || "—"]].map(([k, v]) => (
        <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12.5, padding: "2px 0", color: k === "Gain / loss" ? gainColor(h.gain) : "#5E6E6C" }}>
          <span style={{ color: "#9B8E80" }}>{k}</span><span style={{ fontWeight: 600, textAlign: "right" }}>{v}</span>
        </div>
      ))}
    </div>
  );
}

// A ticker symbol that reveals the holding's detail card on hover. Reused everywhere.
function TickerHover({ h, color, align }) {
  const [show, setShow] = useState(false);
  return (
    <span style={{ position: "relative", display: "inline-block" }} onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      <span style={{ borderBottom: "1px dotted #B7C4C3", cursor: "default", fontWeight: 700, color: color || INK }}>{h.symbol}</span>
      {show && <HoldingDetailCard h={h} align={align} />}
    </span>
  );
}

// One holding row, reused in the (sector-grouped) holdings table.
function HoldingRow({ h, i, narrow }) {
  const td = { padding: "9px 12px", borderBottom: "1px solid #F3ECE3", fontFamily: FONT_BODY };
  const rt = { textAlign: "right" };
  return (
    <tr style={{ background: i % 2 === 0 ? "#fff" : "#FCF7F1" }}>
      <td style={{ ...td, fontWeight: 700, color: INK, whiteSpace: "nowrap" }}><TickerHover h={h} /></td>
      {!narrow && <td style={{ ...td, color: "#5E6E6C", maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.description}</td>}
      <td style={{ ...td, ...rt, color: "#5E6E6C" }}>{h.qty != null ? Number(h.qty).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"}</td>
      <td style={{ ...td, ...rt, color: "#5E6E6C" }}>{h.price != null ? fmt(h.price) : "—"}</td>
      <td style={{ ...td, ...rt, fontWeight: 700, color: INK }}>{h.market_value != null ? fmt(h.market_value) : "—"}</td>
      <td style={{ ...td, ...rt, fontWeight: 600, color: gainColor(h.gain) }}>{h.gain != null ? signed(h.gain) : "—"}{h.gain_pct != null && <span style={{ fontSize: 11, fontWeight: 500 }}> ({Number(h.gain_pct).toFixed(1)}%)</span>}</td>
      <td style={{ ...td, ...rt, color: "#9B8E80" }}>{h.pct_account != null ? Number(h.pct_account).toFixed(1) + "%" : "—"}</td>
    </tr>
  );
}

// Holdings table for one account — grouped by sector, with hover-for-detail on each ticker.
function HoldingsTable({ holdings, narrow }) {
  const th = { padding: "9px 12px", textAlign: "left", fontFamily: FONT_DISPLAY, fontSize: 10.5, letterSpacing: "0.06em", textTransform: "uppercase", color: "#7C8C8A", position: "sticky", top: 0, background: "#FFF8F2" };
  const total = holdings.reduce((s, h) => s + (Number(h.market_value) || 0), 0);
  const bySec = {};
  holdings.forEach(h => { const k = h.sector || "Other"; (bySec[k] = bySec[k] || { total: 0, items: [] }); bySec[k].total += Number(h.market_value) || 0; bySec[k].items.push(h); });
  const groups = Object.entries(bySec).map(([name, v]) => ({ name, total: v.total, items: v.items })).sort((a, b) => b.total - a.total);
  const colSpan = narrow ? 6 : 7;
  let i = 0;
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: narrow ? 560 : "auto" }}>
        <thead>
          <tr>
            <th style={th}>Ticker</th>
            {!narrow && <th style={th}>Name</th>}
            <th style={{ ...th, textAlign: "right" }}>Qty</th>
            <th style={{ ...th, textAlign: "right" }}>Price</th>
            <th style={{ ...th, textAlign: "right" }}>Market Value</th>
            <th style={{ ...th, textAlign: "right" }}>Gain / Loss</th>
            <th style={{ ...th, textAlign: "right" }}>% Acct</th>
          </tr>
        </thead>
        <tbody>
          {groups.map(g => (
            <Fragment key={g.name}>
              <tr>
                <td colSpan={colSpan} style={{ padding: "8px 12px", background: "#FBF4EC", borderBottom: "1px solid #EFE7DD" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", fontFamily: FONT_BODY }}>
                    <span style={{ fontWeight: 700, color: INK, fontSize: 12.5 }}><span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 3, background: secColor(g.name), marginRight: 7 }} />{g.name}</span>
                    <span style={{ color: "#7C8C8A", fontSize: 12 }}>{fmt(g.total)} · {total ? ((g.total / total) * 100).toFixed(1) : 0}%</span>
                  </div>
                </td>
              </tr>
              {g.items.map(h => <HoldingRow key={h.id} h={h} i={i++} narrow={narrow} />)}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SECTOR_COLORS = {
  "Diversified Equity (US)": TEAL, "International Equity": "#2FA39B", "Fixed Income": "#3A6B9C",
  "Industrials": "#C77D3A", "Energy": "#B5451B", "Commodities": "#C9A227", "Financials": "#5B8C5A",
  "Communication Services": "#7B5EA7", "Cash": SUN, "Technology": "#2C7BE5", "Health Care": "#3FA796",
  "Alternatives": "#9B6A8F", "Consumer Discretionary": "#E08A4B", "Real Estate": "#8A6D3B", "Other": "#999",
};
const secColor = s => SECTOR_COLORS[s] || "#999";

// Admin-only account drill-down: by-account view OR holistic by-sector view.
function AccountsDrilldown({ narrow }) {
  const { session, setSession } = useAuth();
  const [accts, setAccts] = useState(null);
  const [all, setAll] = useState([]);
  const [holds, setHolds] = useState({});
  const [sel, setSel] = useState(null);
  const [mode, setMode] = useState("account"); // "account" | "sector"
  const [openSector, setOpenSector] = useState(null);
  const [err, setErr] = useState("");
  const [quotes, setQuotes] = useState({});
  const [quotedAt, setQuotedAt] = useState(null);
  const [pricing, setPricing] = useState(false);
  const [priceErr, setPriceErr] = useState("");

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const a = await authedGet(session, setSession, "accounts?select=*&order=sort_order");
        const h = await authedGet(session, setSession, "holdings?select=*&order=account_id,sort_order");
        if (!live) return;
        const byA = {}; h.forEach(x => { (byA[x.account_id] = byA[x.account_id] || []).push(x); });
        setHolds(byA); setAll(h); setAccts(a);
      } catch (e) { if (live) setErr(e.message); }
    })();
    return () => { live = false; };
  }, []);

  async function refreshPrices(list) {
    const syms = (list || all).map(h => h.symbol).filter(Boolean);
    if (!syms.length) return;
    setPricing(true); setPriceErr("");
    try { const res = await fetchQuotes(session, syms); setQuotes(res.prices || {}); setQuotedAt(res.at || new Date().toISOString()); }
    catch (e) { setPriceErr("Live prices unavailable right now — showing last snapshot."); }
    finally { setPricing(false); }
  }
  useEffect(() => { if (all.length) refreshPrices(all); /* eslint-disable-next-line */ }, [all.length]);

  if (err) return <Card style={{ padding: 20, marginTop: 18, color: "#B5451B", fontSize: 13 }}>Couldn&rsquo;t load accounts: {err}</Card>;
  if (!accts) return <Card style={{ padding: 20, marginTop: 18, color: "#9B8E80", fontSize: 13 }}>Loading accounts…</Card>;

  // Overlay live quotes onto each holding (recompute value + gain); others keep snapshot.
  const applyLive = h => {
    const q = quotes[(h.symbol || "").toUpperCase()];
    if (!q || !q.c || h.qty == null) return h;
    const price = Number(q.c);
    const mv = Number(h.qty) * price;
    const cost = h.cost_basis != null ? Number(h.cost_basis) : null;
    const gain = cost != null ? mv - cost : h.gain;
    const gain_pct = cost ? (gain / cost) * 100 : h.gain_pct;
    return { ...h, price, market_value: mv, gain, gain_pct, _live: true };
  };
  const allLive = all.map(applyLive);
  const holdsLive = {}; allLive.forEach(h => { (holdsLive[h.account_id] = holdsLive[h.account_id] || []).push(h); });
  const liveBalance = a => { const hs = holdsLive[a.id]; return hs && hs.length ? hs.reduce((s, h) => s + (Number(h.market_value) || 0), 0) : a.balance; };

  const selAcct = accts.find(a => a.id === sel);
  const acctName = id => { const a = accts.find(x => x.id === id); return a ? a.mask : id; };
  const portTotal = allLive.reduce((s, h) => s + (Number(h.market_value) || 0), 0);
  const liveCount = Object.keys(quotes).length;

  // Sector aggregation across all accounts (live-adjusted).
  const bySector = {};
  allLive.forEach(h => {
    const k = h.sector || "Other";
    (bySector[k] = bySector[k] || { total: 0, items: [] });
    bySector[k].total += Number(h.market_value) || 0;
    bySector[k].items.push(h);
  });
  const sectorRows = Object.entries(bySector).map(([name, v]) => ({ name, value: v.total, items: v.items })).sort((a, b) => b.value - a.value);

  const priceBadge = (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 11.5, color: "#5E6E6C", fontFamily: FONT_BODY }}>
      {liveCount > 0 && !priceErr
        ? <span style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "#EAF7F2", border: "1px solid #BFE0DE", color: "#0E7A5F", borderRadius: 20, padding: "4px 10px", fontWeight: 700 }}><span style={{ width: 7, height: 7, borderRadius: "50%", background: "#1F9E6E", display: "inline-block" }} />Live · {liveCount} priced{quotedAt ? " · " + new Date(quotedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""}</span>
        : <span style={{ background: "#FBF4EC", border: "1px solid " + LINE, borderRadius: 20, padding: "4px 10px" }}>{pricing ? "Fetching live prices…" : (priceErr || "Snapshot pricing")}</span>}
      <button onClick={() => refreshPrices(all)} disabled={pricing} style={{ background: "none", border: "1px solid " + LINE, borderRadius: 8, padding: "4px 10px", cursor: pricing ? "default" : "pointer", color: TEAL, fontWeight: 700, fontSize: 11.5, fontFamily: FONT_BODY }}>{pricing ? "…" : "Refresh"}</button>
    </span>
  );

  const Toggle = (
    <div style={{ display: "inline-flex", background: "#FBF4EC", border: "1px solid " + LINE, borderRadius: 10, padding: 3, gap: 3 }}>
      {[["account", "By account"], ["sector", "Whole portfolio"]].map(([id, lbl]) => (
        <button key={id} onClick={() => setMode(id)} style={{
          border: "none", cursor: "pointer", borderRadius: 8, padding: "7px 14px", fontFamily: FONT_BODY, fontSize: 13, fontWeight: 700,
          background: mode === id ? "#fff" : "transparent", color: mode === id ? TEAL : "#7C8C8A",
          boxShadow: mode === id ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
        }}>{lbl}</button>
      ))}
    </div>
  );

  return (
    <div style={{ margin: "26px 0 36px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 18 }}>
        {Toggle}
        {priceBadge}
      </div>

      {mode === "account" && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: narrow ? "1fr 1fr" : "repeat(4, 1fr)", gap: 12 }}>
            {accts.map(a => {
              const on = sel === a.id;
              return (
                <button key={a.id} onClick={() => setSel(on ? null : a.id)} style={{
                  textAlign: "left", cursor: "pointer", background: on ? "#F1FAF8" : "#fff",
                  border: "1px solid " + (on ? SOFT_TEAL : LINE), borderTop: "3px solid " + (on ? TEAL : "#D6E6E4"),
                  borderRadius: 14, padding: "14px 16px", fontFamily: FONT_BODY,
                }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#7C8C8A", textTransform: "uppercase", letterSpacing: "0.04em" }}>{a.type}</div>
                  <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: narrow ? 15 : 16, color: INK, lineHeight: 1.15, margin: "3px 0" }}>{a.name}</div>
                  <div style={{ fontSize: 11.5, color: "#9B8E80" }}>{a.institution} · {a.mask}</div>
                  <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 20, color: TEAL, marginTop: 8 }}>{fmtK(liveBalance(a))}</div>
                </button>
              );
            })}
          </div>
          {selAcct && (
            <Card style={{ marginTop: 16, overflow: "hidden" }}>
              <div style={{ padding: "16px 20px", borderBottom: "1px solid #F3ECE3" }}>
                <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 18, color: INK }}>{selAcct.name} <span style={{ fontSize: 13, color: "#9B8E80", fontWeight: 400 }}>{selAcct.mask}</span></div>
                <div style={{ fontSize: 12, color: "#9B8E80" }}>{fmt(liveBalance(selAcct))} · {liveCount > 0 ? "live prices where available, else " : ""}snapshot {selAcct.as_of}</div>
              </div>
              {(holdsLive[selAcct.id] || []).length > 0
                ? <HoldingsTable holdings={holdsLive[selAcct.id]} narrow={narrow} />
                : <div style={{ padding: "24px 20px", color: "#9B8E80", fontSize: 13.5, fontFamily: FONT_BODY }}>This is a cash account — current balance {fmt(selAcct.balance)}, no securities held.</div>}
            </Card>
          )}
        </>
      )}

      {mode === "sector" && (
        <div style={{ display: "grid", gridTemplateColumns: narrow ? "1fr" : "minmax(0,0.9fr) minmax(0,1.1fr)", gap: 20 }}>
          <Card style={{ padding: 24 }}>
            <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 18, marginBottom: 2 }}>Whole Portfolio by Sector</div>
            <div style={{ fontSize: 12, color: "#9B8E80", marginBottom: 14 }}>{fmt(portTotal)} across {all.length} positions · all 4 accounts combined</div>
            <div style={{ width: "100%", height: 260 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={sectorRows} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={58} outerRadius={104} paddingAngle={2} isAnimationActive={false}>
                    {sectorRows.map(s => <Cell key={s.name} fill={secColor(s.name)} />)}
                  </Pie>
                  <Tooltip formatter={(v, n) => [fmt(v), n]} contentStyle={{ fontFamily: FONT_BODY, fontSize: 12.5 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </Card>
          <Card style={{ padding: 22 }}>
            <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 18, marginBottom: 14 }}>Breakdown</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {sectorRows.map(s => {
                const pct = portTotal ? (s.value / portTotal) * 100 : 0;
                const open = openSector === s.name;
                return (
                  <div key={s.name}>
                    <button onClick={() => setOpenSector(open ? null : s.name)} style={{ width: "100%", textAlign: "left", background: "none", border: "none", cursor: "pointer", padding: 0, fontFamily: FONT_BODY }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4, fontSize: 13.5 }}>
                        <span style={{ fontWeight: 600, color: INK }}><span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 3, background: secColor(s.name), marginRight: 7 }} />{s.name}</span>
                        <span style={{ color: "#7C8C8A" }}>{fmtK(s.value)} <span style={{ fontSize: 11.5 }}>({pct.toFixed(1)}%)</span> <span style={{ color: "#C3B8AC", fontSize: 11 }}>{open ? "▲" : "▾"}</span></span>
                      </div>
                      <div style={{ height: 8, background: "#F3ECE3", borderRadius: 4 }}>
                        <div style={{ height: 8, width: Math.max(1, pct) + "%", background: secColor(s.name), borderRadius: 4 }} />
                      </div>
                    </button>
                    {open && (
                      <div style={{ margin: "8px 0 4px", paddingLeft: 16 }}>
                        {s.items.slice().sort((a, b) => (Number(b.market_value) || 0) - (Number(a.market_value) || 0)).map(h => (
                          <div key={h.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "3px 0", color: "#5E6E6C", fontFamily: FONT_BODY }}>
                            <span><TickerHover h={h} align="left" /> <span style={{ color: "#9B8E80" }}>· {acctName(h.account_id)}</span></span>
                            <span>{fmt(h.market_value)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

function InvestmentsView({ narrow }) {
  const { investments } = useData();
  const { signedIn, member } = useAuth();
  const [editing, setEditing] = useState(false);
  const [showAccts, setShowAccts] = useState(false);
  const data = investments.composition;
  const corpus = corpusTotal(investments);
  const classColor = { "Equities": TEAL, "Fixed Income": "#3A6B9C", "Cash": SUN, "Managed Investments (Schwab)": TEAL };
  const colors = [TEAL, "#3A6B9C", SUN, CORAL, "#7B5EA7"];
  const colorOf = (name, i) => classColor[name] || colors[i % colors.length];
  return (
    <div style={{ maxWidth: 1140, margin: "0 auto", padding: narrow ? "28px 16px" : "36px 40px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <SectionTitle title="Investments" sub={"The foundation's endowment — invested to grow and fund the giving · as of " + investments.asOf} />
        {signedIn && !editing && <MiniButton kind="edit" onClick={() => setEditing(true)}>Edit figures</MiniButton>}
      </div>

      {signedIn && editing && <InvestmentEditor investments={investments} onDone={() => setEditing(false)} />}

      <div style={{ display: "grid", gridTemplateColumns: narrow ? "1fr" : "repeat(3, 1fr)", gap: 16, marginBottom: 24 }}>
        <StatCard label="Total Corpus" value={fmtK(corpus)} sub={"as of " + investments.asOf} accent={TEAL} />
        {member ? (
          <button onClick={() => setShowAccts(s => !s)} style={{ textAlign: "left", cursor: "pointer", background: showAccts ? "#FFF3EC" : "#fff", border: "1px solid " + (showAccts ? CORAL : "#EFE7DD"), borderTop: "3px solid " + CORAL, borderRadius: 18, padding: "20px 24px" }}>
            <div style={{ fontSize: 11, fontFamily: FONT_BODY, fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase", color: "#7C8C8A", marginBottom: 6 }}>Accounts</div>
            <div style={{ fontSize: 30, fontWeight: 600, color: "#1F3A38", fontFamily: FONT_DISPLAY, lineHeight: 1 }}>{investments.accounts || "—"}</div>
            <div style={{ fontSize: 12, color: CORAL, marginTop: 4, fontFamily: FONT_BODY, fontWeight: 700 }}>{showAccts ? "Hide detail ▲" : "View accounts & holdings ▾"}</div>
          </button>
        ) : (
          <StatCard label="Accounts" value={investments.accounts || "—"} sub="managed & brokerage" accent={CORAL} />
        )}
        <StatCard label="Asset Classes" value={data.length} sub="equities, fixed income, cash" accent={SUN} />
      </div>

      {member && showAccts && <AccountsDrilldown narrow={narrow} />}

      <div style={{ display: "grid", gridTemplateColumns: narrow ? "1fr" : "minmax(0,1fr) minmax(0,1fr)", gap: 20 }}>
        <Card style={{ padding: 24 }}>
          <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 18, marginBottom: 8 }}>Asset Allocation</div>
          <div style={{ width: "100%", height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={data} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={62} outerRadius={106} paddingAngle={2} isAnimationActive={false}>
                  {data.map((entry, i) => <Cell key={entry.name} fill={colorOf(entry.name, i)} />)}
                </Pie>
                <Tooltip formatter={v => fmt(v)} contentStyle={{ fontFamily: FONT_BODY, fontSize: 13 }} />
                <Legend wrapperStyle={{ fontFamily: FONT_BODY, fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card style={{ padding: 24 }}>
          <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 18, marginBottom: 20 }}>Breakdown</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {data.map((a, i) => {
              const pct = corpus ? Math.round((a.value / corpus) * 100) : 0;
              return (
                <div key={a.name}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5, fontSize: 14 }}>
                    <span style={{ fontWeight: 600, fontFamily: FONT_BODY }}>{a.name}</span>
                    <span style={{ color: "#7C8C8A", fontFamily: FONT_BODY }}>{fmtK(a.value)} <span style={{ fontSize: 12 }}>({pct}%)</span></span>
                  </div>
                  <div style={{ height: 9, background: "#F3ECE3", borderRadius: 5 }}>
                    <div style={{ height: 9, width: pct + "%", background: colorOf(a.name, i), borderRadius: 5 }} />
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 24, paddingTop: 18, borderTop: "1px solid " + LINE, fontSize: 12, color: "#9B8E80", lineHeight: 1.55 }}>
            By asset class, as of {investments.asOf}. Public visitors see allocation only — account-level holdings open privately for signed-in family via the Accounts tile above.
          </div>
        </Card>
      </div>
    </div>
  );
}

// =============================================================================
//  GRANTS MADE VIEW  (Grant Log / Year Over Year / By Category)
// =============================================================================

function GrantsView({ narrow }) {
  const { grants, granteeNotes } = useData();
  const { signedIn, member, session, setSession, email } = useAuth();
  const [docs, setDocs] = useState({});   // grant_id -> uploaded documents
  const [yearFilter, setYearFilter] = useState("All Years");
  const [orgFilter,  setOrgFilter]  = useState("All Organizations");
  const [catFilter,  setCatFilter]  = useState("All Categories");
  const [tab, setTab] = useState("grants");
  const [editId, setEditId] = useState(null); // grant id being edited, or "new"
  const [signerIdx, setSignerIdx] = useState(0);   // who signs the cover letters
  const [sortKey, setSortKey] = useState("date");  // default: most recent first
  const [sortDir, setSortDir] = useState("desc");

  // Undated grants sort at the end of their year so old and new stay in one sensible order.
  const sortVal = (g, key) => {
    if (key === "year")     return g.year || 0;
    if (key === "org")      return String(orgLabel(g.org, granteeNotes) || "").toLowerCase();
    if (key === "category") return String(g.category || "").toLowerCase();
    if (key === "amount")   return Number(g.amount) || 0;
    if (key === "check")    return g.checkNumber ? Number(g.checkNumber) || 0 : -1;
    return g.checkDate || (g.year + "-12-31");
  };
  const compareGrants = (a, b) => {
    const va = sortVal(a, sortKey), vb = sortVal(b, sortKey);
    let r = va < vb ? -1 : va > vb ? 1 : 0;
    if (sortDir === "desc") r = -r;
    if (r !== 0) return r;
    const da = sortVal(a, "date"), db = sortVal(b, "date");   // tiebreak: newest, then largest
    if (da !== db) return da < db ? 1 : -1;
    return (Number(b.amount) || 0) - (Number(a.amount) || 0);
  };
  const toggleSort = key => {
    if (key === sortKey) { setSortDir(d => (d === "desc" ? "asc" : "desc")); return; }
    setSortKey(key);
    setSortDir(key === "org" || key === "category" ? "asc" : "desc");  // names read better A-Z
  };

  const [folders, setFolders] = useState({});
  const loadFolders = async () => {
    if (!member) { setFolders({}); return; }
    try {
      const rows = await authedGet(session, setSession, "tax_year_folders?select=year,url");
      const m = {}; rows.forEach(r => { m[r.year] = r.url; });
      setFolders(m);
    } catch { /* link simply won't show */ }
  };
  useEffect(() => { loadFolders(); /* eslint-disable-next-line */ }, [member]);

  // One query for every grant's paperwork, indexed by grant so each row is cheap.
  const loadDocs = async () => {
    if (!member) { setDocs({}); return; }
    try {
      const rows = await authedGet(session, setSession,
        "grant_documents?select=id,grant_id,kind,storage_path,filename,uploaded_at&order=uploaded_at.desc");
      const m = {};
      rows.forEach(r => { (m[r.grant_id] = m[r.grant_id] || []).push(r); });
      setDocs(m);
    } catch { /* leave the buttons in their empty state */ }
  };
  useEffect(() => { loadDocs(); /* eslint-disable-next-line */ }, [member]);

  // Default the signature to whoever is signed in, so letters go out in their own name.
  useEffect(() => {
    const i = SIGNERS.findIndex(x => x.email && email && x.email.toLowerCase() === email.toLowerCase());
    if (i >= 0) setSignerIdx(i);
  }, [email]);

  const ALL_YEARS = useMemo(() => yearOptions(grants), [grants]);
  const ALL_ORGS  = useMemo(() => orgOptions(grants),  [grants]);
  const ALL_CATS  = useMemo(() => catOptions(grants),  [grants]);
  const totalGranted = sumAmount(grants);

  const filtered = useMemo(() => grants.filter(g => {
    if (yearFilter !== "All Years" && g.year !== Number(yearFilter)) return false;
    if (orgFilter  !== "All Organizations" && g.org !== orgFilter)   return false;
    if (catFilter  !== "All Categories" && g.category !== catFilter) return false;
    return true;
  }), [grants, yearFilter, orgFilter, catFilter]);

  const totalGiven = filtered.reduce((s, g) => s + g.amount, 0);
  const uniqueOrgs = new Set(filtered.map(g => g.org)).size;

  const yoyData = useMemo(() => {
    const byYear = {};
    grants.forEach(g => { byYear[g.year] = (byYear[g.year] || 0) + g.amount; });
    return Object.entries(byYear).sort((a,b) => a[0]-b[0]).map(([yr, amt]) => ({ year: yr, amount: amt }));
  }, [grants]);

  const orgHistory = useMemo(() => {
    if (orgFilter === "All Organizations") return [];
    const byYear = {};
    grants.filter(g => g.org === orgFilter).forEach(g => { byYear[g.year] = (byYear[g.year] || 0) + g.amount; });
    return Object.entries(byYear).sort((a,b) => a[0]-b[0]).map(([yr, amt]) => ({ year: yr, amount: amt }));
  }, [grants, orgFilter]);

  const catData = useMemo(() => {
    const byCat = {};
    filtered.forEach(g => { byCat[g.category] = (byCat[g.category] || 0) + g.amount; });
    return Object.entries(byCat).map(([name, value]) => ({ name, value })).sort((a,b) => b.value-a.value);
  }, [filtered]);

  const TABS = [
    { id: "grants",     label: "Grant Log" },
    { id: "yoy",        label: "Year Over Year" },
    { id: "categories", label: "By Category" },
  ];
  const hasFilters = yearFilter !== "All Years" || orgFilter !== "All Organizations" || catFilter !== "All Categories";

  return (
    <div style={{ maxWidth: 1680, margin: "0 auto", padding: narrow ? "28px 16px" : "36px 40px" }}>
      <SectionTitle title="Grants Made" sub="Every grant since 2001, filterable by year, organization, and focus area" />

      {/* Filters */}
      <Card style={{ padding: "16px 20px", display: "flex", gap: 20, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 20 }}>
        <div style={{ fontSize: 12, fontFamily: "'Fredoka', serif", letterSpacing: "0.1em", textTransform: "uppercase", color: "#7C8C8A", alignSelf: "center", paddingBottom: 2 }}>Filter</div>
        <FilterSelect label="Year" value={yearFilter} onChange={setYearFilter} options={ALL_YEARS.map(String)} />
        <FilterSelect label="Organization" value={orgFilter} onChange={setOrgFilter} options={ALL_ORGS} />
        <FilterSelect label="Category" value={catFilter} onChange={setCatFilter} options={ALL_CATS} />
        {hasFilters && (
          <button onClick={() => { setYearFilter("All Years"); setOrgFilter("All Organizations"); setCatFilter("All Categories"); }}
            style={{ background: "none", border: "1px solid #E2D7C9", borderRadius: 6, padding: "7px 14px", fontSize: 12, color: "#7C8C8A", cursor: "pointer", fontFamily: "'Nunito Sans', sans-serif" }}>Clear</button>
        )}
        {member && yearFilter !== "All Years" && (
          <div style={{ marginLeft: "auto", alignSelf: "center" }}>
            <TaxFolderLink year={Number(yearFilter)} url={folders[yearFilter]} onChange={loadFolders} readOnly={!signedIn} />
          </div>
        )}
      </Card>

      {/* Stat cards */}
      <div style={{ display: "grid", gridTemplateColumns: narrow ? "1fr" : "repeat(3, 1fr)", gap: 16, marginBottom: 24 }}>
        <StatCard label="Grants in View" value={fmt(totalGiven)} sub={filtered.length + " grants"} accent={TEAL} />
        <StatCard label="Organizations" value={uniqueOrgs} sub="unique grantees" accent="#C8A020" />
        <StatCard label="All-Time Granted" value={fmt(totalGranted)} sub="2001 to present" accent="#3A6B9C" />
      </div>

      {/* Sub-tabs */}
      <div style={{ display: "flex", gap: 2, marginBottom: 20, borderBottom: "2px solid #EFE7DD" }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            background: "none", border: "none", borderBottom: tab === t.id ? "2px solid " + TEAL : "2px solid transparent",
            marginBottom: -2, padding: "10px 18px", fontSize: 13, fontFamily: "'Nunito Sans', sans-serif",
            fontWeight: tab === t.id ? 600 : 400, color: tab === t.id ? TEAL : "#7C8C8A", cursor: "pointer",
          }}>{t.label}</button>
        ))}
      </div>

      {tab === "grants" && (
        <Card style={{ overflow: "hidden" }}>
          {signedIn && (
            <div style={{ padding: "12px 16px", borderBottom: "1px solid #F3ECE3", background: "#FBF4EC", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, color: "#7C8C8A" }}>You're signed in — click <strong>Edit</strong> on any grant, or add a new one.</span>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <label style={{ fontSize: 12, color: "#7C8C8A", display: "inline-flex", alignItems: "center", gap: 6 }}>
                  Letters signed by
                  <select value={signerIdx} onChange={e => setSignerIdx(Number(e.target.value))} style={{
                    fontFamily: FONT_BODY, fontSize: 12, padding: "5px 8px", borderRadius: 6,
                    border: "1px solid #E2D7C9", background: "#fff", color: INK, cursor: "pointer",
                  }}>
                    {SIGNERS.map((sg, i) => <option key={sg.name} value={i}>{sg.name} — {sg.title}</option>)}
                  </select>
                </label>
                <MiniButton kind="edit" onClick={() => setEditId(editId === "new" ? null : "new")}>{editId === "new" ? "Close" : "+ Add grant"}</MiniButton>
              </div>
            </div>
          )}
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: member ? 1180 : 620 }}>
              <thead>
                <tr style={{ background: "#FFF8F2", borderBottom: "1px solid #EFE7DD" }}>
                  {[["year", "Year"], ["org", "Organization"], ["category", "Category"], ["amount", "Amount"], ["date", "Check Date"], ["check", "Check #"]]
                    .concat(member ? [["", "Tax folder"], ["", signedIn ? "Actions" : "Receipt"]] : []).map(([key, label]) => (
                    <th key={label} style={{ padding: label === "Actions" || label === "Receipt" ? "12px 28px 12px 16px" : "12px 16px", textAlign: "left", fontFamily: "'Fredoka', serif", fontWeight: 600, fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "#7C8C8A", whiteSpace: "nowrap" }}>
                      {key ? (
                        <button onClick={() => toggleSort(key)} title={"Sort by " + label} style={{
                          background: "none", border: "none", padding: 0, cursor: "pointer",
                          fontFamily: "'Fredoka', serif", fontWeight: 600, fontSize: 11, letterSpacing: "0.08em",
                          textTransform: "uppercase", color: sortKey === key ? TEAL : "#7C8C8A",
                          display: "inline-flex", alignItems: "center", gap: 4,
                        }}>
                          {label}
                          <span style={{ fontSize: 8, opacity: sortKey === key ? 1 : 0.3 }}>{sortKey === key && sortDir === "asc" ? "▲" : "▼"}</span>
                        </button>
                      ) : label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {signedIn && editId === "new" && <GrantEditRow row={null} onDone={() => setEditId(null)} narrow={narrow} />}
                {filtered.length === 0 && <tr><td colSpan={member ? 8 : 6} style={{ padding: 32, textAlign: "center", color: "#7C8C8A" }}>No grants match your filters.</td></tr>}
                {filtered.slice().sort(compareGrants).map((g, i) => (
                  editId === g.id && g.id != null ? (
                    <GrantEditRow key={"edit" + g.id} row={g} onDone={() => setEditId(null)} narrow={narrow} />
                  ) : (
                  <tr key={g.id ?? g.org + g.year + i} style={{ borderBottom: "1px solid #F3ECE3", background: i % 2 === 0 ? "#fff" : "#FCF7F1" }}>
                    <td style={{ padding: "11px 16px", color: "#7C8C8A", fontWeight: 500 }}>{g.year}</td>
                    <td style={{ padding: "11px 16px", fontWeight: 500 }}>{orgLabel(g.org, granteeNotes)}</td>
                    <td style={{ padding: "11px 16px" }}>
                      <span style={{ background: (CAT_COLORS[g.category] || "#999") + "18", color: CAT_COLORS[g.category] || "#999", borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}>{g.category}</span>
                    </td>
                    <td style={{ padding: "11px 16px", fontWeight: 700, color: TEAL, whiteSpace: "nowrap" }}>{fmt(g.amount)}</td>
                    <td style={{ padding: "11px 16px", color: "#7C8C8A", whiteSpace: "nowrap" }}>{g.checkDate ? fmtCheckDate(g.checkDate) : <span style={{ color: "#C8BBA8" }}>—</span>}</td>
                    <td style={{ padding: "11px 16px", color: "#7C8C8A", whiteSpace: "nowrap" }}>{g.checkNumber ? "#" + g.checkNumber : <span style={{ color: "#C8BBA8" }}>—</span>}</td>
                    {member && (
                      <td style={{ padding: "11px 16px", whiteSpace: "nowrap" }}>
                        {folders[g.year]
                          ? <a href={folders[g.year]} target="_blank" rel="noopener noreferrer"
                               title={"Open the " + g.year + " folder in Google Drive"}
                               style={{ color: TEAL, fontWeight: 700, fontSize: 12, textDecoration: "none", fontFamily: FONT_BODY }}>{g.year} folder &rarr;</a>
                          : <span style={{ color: "#C8BBA8", fontSize: 11.5 }}>—</span>}
                      </td>
                    )}
                    {member && (
                      <td style={{ padding: "12px 28px 12px 16px", whiteSpace: "nowrap" }}>
                        {g.id != null
                          ? <div style={{ display: "flex", gap: 8, flexWrap: "nowrap", alignItems: "center" }}>
                              {signedIn && <MiniButton kind="edit" onClick={() => setEditId(g.id)}>Edit</MiniButton>}
                              {signedIn && <GrantLetterButton grant={g} signer={SIGNERS[signerIdx]} />}
                              <GrantReceiptButton grant={g} docs={docs[g.id]} onChange={loadDocs} readOnly={!signedIn} />
                            </div>
                          : <span style={{ fontSize: 11, color: "#C8BBA8" }}>—</span>}
                      </td>
                    )}
                  </tr>
                  )
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {tab === "yoy" && (
        <div style={{ display: "grid", gridTemplateColumns: !narrow && orgFilter !== "All Organizations" ? "1fr 1fr" : "1fr", gap: 20 }}>
          <Card style={{ padding: 24 }}>
            <div style={{ fontFamily: "'Fredoka', serif", fontWeight: 600, fontSize: 18, marginBottom: 4 }}>Total Giving by Year</div>
            <div style={{ fontSize: 12, color: "#7C8C8A", marginBottom: 20 }}>2001 through {currentCycleYear(grants)}</div>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={yoyData} margin={{ bottom: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#F3ECE3" />
                <XAxis dataKey="year" tick={{ fontFamily: "'Nunito Sans', sans-serif", fontSize: 11 }} interval={2} />
                <YAxis tickFormatter={fmtK} tick={{ fontFamily: "'Nunito Sans', sans-serif", fontSize: 11 }} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="amount" fill={TEAL} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Card>
          {orgFilter !== "All Organizations" && orgHistory.length > 0 && (
            <Card style={{ padding: 24 }}>
              <div style={{ fontFamily: "'Fredoka', serif", fontWeight: 600, fontSize: 18, marginBottom: 4 }}>{orgFilter}</div>
              <div style={{ fontSize: 12, color: "#7C8C8A", marginBottom: 20 }}>Giving history for this organization</div>
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={orgHistory}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#F3ECE3" />
                  <XAxis dataKey="year" tick={{ fontFamily: "'Nunito Sans', sans-serif", fontSize: 11 }} />
                  <YAxis tickFormatter={fmtK} tick={{ fontFamily: "'Nunito Sans', sans-serif", fontSize: 11 }} />
                  <Tooltip content={<CustomTooltip />} />
                  <Line type="monotone" dataKey="amount" stroke="#C8A020" strokeWidth={2.5} dot={{ fill: "#C8A020", r: 5 }} />
                </LineChart>
              </ResponsiveContainer>
            </Card>
          )}
        </div>
      )}

      {tab === "categories" && (
        <div style={{ display: "grid", gridTemplateColumns: narrow ? "1fr" : "1fr 1fr", gap: 20 }}>
          <Card style={{ padding: 24 }}>
            <div style={{ fontFamily: "'Fredoka', serif", fontWeight: 600, fontSize: 18, marginBottom: 20 }}>Giving by Focus Area</div>
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie data={catData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={55} outerRadius={100} paddingAngle={2}>
                  {catData.map(entry => <Cell key={entry.name} fill={CAT_COLORS[entry.name] || "#999"} />)}
                </Pie>
                <Tooltip formatter={v => fmt(v)} contentStyle={{ fontFamily: "'Nunito Sans', sans-serif", fontSize: 13 }} />
                <Legend wrapperStyle={{ fontFamily: "'Nunito Sans', sans-serif", fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          </Card>
          <Card style={{ padding: 24 }}>
            <div style={{ fontFamily: "'Fredoka', serif", fontWeight: 600, fontSize: 18, marginBottom: 20 }}>Breakdown</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
              {catData.map(c => {
                const pct = totalGiven ? Math.round((c.value / totalGiven) * 100) : 0;
                return (
                  <div key={c.name}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 13 }}>
                      <span style={{ fontWeight: 500 }}>{c.name}</span>
                      <span style={{ color: "#7C8C8A" }}>{fmt(c.value)} <span style={{ fontSize: 11 }}>({pct}%)</span></span>
                    </div>
                    <div style={{ height: 6, background: "#F3ECE3", borderRadius: 3 }}>
                      <div style={{ height: 6, width: pct + "%", background: CAT_COLORS[c.name] || "#999", borderRadius: 3 }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

// =============================================================================
//  CONTRIBUTIONS VIEW
// =============================================================================

function ContributionsView({ narrow }) {
  const { donations, contributionGifts, refresh } = useData();
  const { signedIn, member, email, session, setSession } = useAuth();
  const [signerIdx, setSignerIdx] = useState(0);   // who signs the receipts
  const [editId, setEditId] = useState(null);
  const [openYear, setOpenYear] = useState(null);
  const totalReceived = sumAmount(donations);

  const [folders, setFolders] = useState({});
  const loadFolders = async () => {
    if (!member) { setFolders({}); return; }
    try {
      const rows = await authedGet(session, setSession, "tax_year_folders?select=year,url");
      const m = {}; rows.forEach(r => { m[r.year] = r.url; });
      setFolders(m);
    } catch { /* link simply won't show */ }
  };
  useEffect(() => { loadFolders(); /* eslint-disable-next-line */ }, [member]);

  // Documents filed against each gift, indexed by gift.
  const [giftDocs, setGiftDocs] = useState({});
  const loadGiftDocs = async () => {
    if (!member) { setGiftDocs({}); return; }
    try {
      const rows = await authedGet(session, setSession,
        "gift_documents?select=id,gift_id,storage_path,filename,uploaded_at&order=uploaded_at.desc");
      const m = {};
      rows.forEach(r => { (m[r.gift_id] = m[r.gift_id] || []).push(r); });
      setGiftDocs(m);
    } catch { /* buttons fall back to their empty state */ }
  };
  useEffect(() => { loadGiftDocs(); /* eslint-disable-next-line */ }, [member]);

  // Receipts go out over the signer's name — default to whoever is signed in.
  useEffect(() => {
    const i = SIGNERS.findIndex(x => x.email && email && x.email.toLowerCase() === email.toLowerCase());
    if (i >= 0) setSignerIdx(i);
  }, [email]);

  // Individual gifts behind each year. Older years have none — the ledger only ever held a yearly total.
  const giftsByYear = useMemo(() => {
    const m = {};
    (contributionGifts || []).forEach(g => {
      const y = Number(String(g.giftDate || "").slice(0, 4));
      if (y) (m[y] = m[y] || []).push(g);
    });
    Object.values(m).forEach(list => list.sort((a, b) => (a.giftDate < b.giftDate ? 1 : -1)));
    return m;
  }, [contributionGifts]);
  const donByYear = useMemo(() => {
    const byYear = {};
    donations.forEach(d => { byYear[d.year] = (byYear[d.year] || 0) + d.amount; });
    return Object.entries(byYear).sort((a,b) => a[0]-b[0]).map(([yr, amt]) => ({ year: yr, amount: amt }));
  }, [donations]);
  const largest = donations.slice().sort((a, b) => b.amount - a.amount)[0] || { amount: 0, year: "", donor: "" };
  const years = new Set(donations.map(d => d.year)).size;

  return (
    <div style={{ maxWidth: 1140, margin: "0 auto", padding: narrow ? "28px 16px" : "36px 40px" }}>
      <SectionTitle title="Contributions" sub="Gifts into the Kendacar fund since 2000" />

      <div style={{ display: "grid", gridTemplateColumns: narrow ? "1fr" : "repeat(3, 1fr)", gap: 16, marginBottom: 28 }}>
        <StatCard label="Total Contributed" value={fmt(totalReceived)} sub="all donors, since 2000" accent={TEAL} />
        <StatCard label="Largest Year" value={fmt(largest.amount)} sub={largest.year + " · " + largest.donor} accent="#C8A020" />
        <StatCard label="Years With Gifts" value={years} sub="distinct giving years" accent="#3A6B9C" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: narrow ? "1fr" : "1fr 1fr", gap: 20 }}>
        <Card style={{ padding: 24 }}>
          <div style={{ fontFamily: "'Fredoka', serif", fontWeight: 600, fontSize: 18, marginBottom: 4 }}>Contributions by Year</div>
          <div style={{ fontSize: 12, color: "#7C8C8A", marginBottom: 20 }}>Total contributed: <strong style={{ color: TEAL }}>{fmt(totalReceived)}</strong></div>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={donByYear}>
              <defs>
                <linearGradient id="tealGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={TEAL} stopOpacity={0.15} />
                  <stop offset="95%" stopColor={TEAL} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#F3ECE3" />
              <XAxis dataKey="year" tick={{ fontFamily: "'Nunito Sans', sans-serif", fontSize: 11 }} interval={3} />
              <YAxis tickFormatter={fmtK} tick={{ fontFamily: "'Nunito Sans', sans-serif", fontSize: 11 }} />
              <Tooltip content={<CustomTooltip />} />
              <Area type="monotone" dataKey="amount" stroke={TEAL} strokeWidth={2} fill="url(#tealGrad)" />
            </AreaChart>
          </ResponsiveContainer>
        </Card>
        <Card style={{ overflow: "hidden" }}>
          <div style={{ padding: "16px 20px", borderBottom: "1px solid #F3ECE3", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
            <div style={{ fontFamily: "'Fredoka', serif", fontWeight: 600, fontSize: 18 }}>Contribution History</div>
            {signedIn && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <label style={{ fontSize: 12, color: "#7C8C8A", display: "inline-flex", alignItems: "center", gap: 6 }}>
                  Receipts signed by
                  <select value={signerIdx} onChange={e => setSignerIdx(Number(e.target.value))} style={{
                    fontFamily: FONT_BODY, fontSize: 12, padding: "5px 8px", borderRadius: 6,
                    border: "1px solid #E2D7C9", background: "#fff", color: INK, cursor: "pointer",
                  }}>
                    {SIGNERS.map((sg, i) => <option key={sg.name} value={i}>{sg.name} — {sg.title}</option>)}
                  </select>
                </label>
                <MiniButton kind="edit" onClick={() => setEditId(editId === "new" ? null : "new")}>{editId === "new" ? "Close" : "+ Add"}</MiniButton>
              </div>
            )}
          </div>
          <div style={{ maxHeight: 340, overflowY: "auto", overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: signedIn ? 480 : 360 }}>
              <thead>
                <tr style={{ background: "#FFF8F2" }}>
                  {["Year", "Donor", "Amount", "Detail"].concat(signedIn ? ["Edit"] : []).map(h => (
                    <th key={h} style={{ padding: "10px 16px", textAlign: "left", fontFamily: "'Fredoka', serif", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "#7C8C8A" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {signedIn && editId === "new" && <DonationEditRow row={null} onDone={() => setEditId(null)} />}
                {donations.slice().sort((a,b) => b.year - a.year).map((d, i) => (
                  editId === d.id && d.id != null ? (
                    <DonationEditRow key={"edit" + d.id} row={d} onDone={() => setEditId(null)} />
                  ) : (
                  <Fragment key={d.id ?? d.donor + d.year + i}>
                  <tr style={{ borderBottom: "1px solid #F3ECE3", background: i % 2 === 0 ? "#fff" : "#FCF7F1" }}>
                    <td style={{ padding: "10px 16px", color: "#7C8C8A" }}>
                      <div>{d.year}</div>
                      {member && (folders[d.year] || (signedIn && openYear === d.year)) && (
                        <div style={{ marginTop: 3 }}>
                          <TaxFolderLink year={d.year} url={folders[d.year]} onChange={loadFolders} compact readOnly={!signedIn} />
                        </div>
                      )}
                    </td>
                    <td style={{ padding: "10px 16px", fontWeight: 500 }}>{d.donor}</td>
                    <td style={{ padding: "10px 16px", fontWeight: 700, color: TEAL }}>{fmt(d.amount)}</td>
                    <td style={{ padding: "10px 16px", whiteSpace: "nowrap" }}>
                      {(giftsByYear[d.year] || []).length > 0 ? (
                        <button onClick={() => setOpenYear(openYear === d.year ? null : d.year)} style={{
                          background: "none", border: "none", padding: 0, cursor: "pointer", color: TEAL,
                          fontFamily: FONT_BODY, fontSize: 12, fontWeight: 700,
                        }}>
                          {openYear === d.year ? "Hide" : "Show"} {giftsByYear[d.year].length} gift{giftsByYear[d.year].length === 1 ? "" : "s"}
                        </button>
                      ) : <span style={{ fontSize: 11.5, color: "#C8BBA8" }}>total only</span>}
                    </td>
                    {signedIn && <td style={{ padding: "10px 16px" }}>{d.id != null ? <MiniButton kind="edit" onClick={() => setEditId(d.id)}>Edit</MiniButton> : <span style={{ fontSize: 11, color: "#C8BBA8" }}>—</span>}</td>}
                  </tr>
                  {openYear === d.year && (giftsByYear[d.year] || []).map(g => {
                    const itemized = (giftsByYear[d.year] || []).reduce((s, x) => s + x.amount, 0);
                    const isFirst = giftsByYear[d.year][0].id === g.id;
                    return (
                      <Fragment key={"g" + g.id}>
                        {isFirst && itemized < d.amount && (
                          <tr style={{ background: "#FBF4EC" }}>
                            <td colSpan={signedIn ? 5 : 4} style={{ padding: "8px 16px 4px 32px", fontSize: 11.5, color: "#9B8E80", fontFamily: FONT_BODY }}>
                              {fmt(itemized)} of {fmt(d.amount)} itemized — the remainder of this year has no gift detail on record.
                            </td>
                          </tr>
                        )}
                        <tr style={{ background: "#FBF4EC", borderBottom: "1px solid #F3ECE3" }}>
                          <td style={{ padding: "8px 16px 8px 32px", color: "#5E6E6C", whiteSpace: "nowrap", fontSize: 12.5 }}>{fmtCheckDate(g.giftDate)}</td>
                          <td colSpan={2} style={{ padding: "8px 16px", fontSize: 12.5, color: "#5E6E6C" }}>
                            <strong style={{ color: INK }}>{fmt(g.amount)}</strong>
                            {g.giftType === "securities"
                              ? " · " + (g.securities.length
                                  ? g.securities.map(x => x.quantity + " " + x.symbol).join(", ")
                                  : "securities")
                              : " · cash"}
                            {g.note ? <span style={{ color: "#9B8E80" }}> · {g.note}</span> : null}
                          </td>
                          <td colSpan={signedIn ? 2 : 1} style={{ padding: "8px 16px", fontSize: 12, whiteSpace: "nowrap" }}>
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                              {g.receiptDate
                                ? <span style={{ color: "#1F9E6E", fontWeight: 700 }}>receipted {fmtCheckDate(g.receiptDate)}</span>
                                : <span style={{ color: CORAL, fontWeight: 700 }}>no receipt yet</span>}
                              {signedIn && <GiftReceiptButton gift={g} signer={SIGNERS[signerIdx]} onDone={async () => { await refresh(); await loadGiftDocs(); }} />}
                              {member && <GiftDocButton gift={g} docs={giftDocs[g.id]} onChange={loadGiftDocs} readOnly={!signedIn} />}
                            </span>
                          </td>
                        </tr>
                      </Fragment>
                    );
                  })}
                  </Fragment>
                  )
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}

// =============================================================================
//  GRANTEES DIRECTORY + DETAIL
// =============================================================================

function buildGranteeIndex(grants, notes) {
  const map = {};
  grants.forEach(g => {
    const key = normalizeOrg(g.org);
    if (!map[key]) map[key] = { org: key, total: 0, count: 0, years: new Set(), category: g.category, grants: [] };
    map[key].total += g.amount;
    map[key].count += 1;
    map[key].years.add(g.year);
    map[key].grants.push(g);
  });
  const out = Object.values(map).map(o => ({
    ...o,
    firstYear: Math.min(...o.years),
    lastYear: Math.max(...o.years),
    yearCount: o.years.size,
  })).sort((a, b) => b.total - a.total);
  // Organizations with a profile but no grant yet, so details can be checked before the check is written.
  if (notes) {
    const seen = new Set(out.map(o => o.org));
    Object.keys(notes).forEach(org => {
      const key = normalizeOrg(org);
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ org: key, total: 0, count: 0, years: new Set(), category: null, grants: [],
                   firstYear: null, lastYear: null, yearCount: 0, pending: true });
      }
    });
  }
  return out;
}

function GranteesDirectory({ goGrantee, narrow }) {
  const { grants, granteeNotes, granteeDocs } = useData();
  const index = useMemo(() => buildGranteeIndex(grants, granteeNotes), [grants, granteeNotes]);
  const recentYear = new Date().getFullYear() - 1;
  const nameOf = o => (granteeNotes[o.org] && granteeNotes[o.org].displayName) || o.org;
  const [q, setQ] = useState("");
  const list = index.filter(o => nameOf(o).toLowerCase().includes(q.toLowerCase()) || o.org.toLowerCase().includes(q.toLowerCase()));

  // Aggregate all giving by focus area for the donut + top-area tile.
  const { catData, totalAll, top, topSeries } = useMemo(() => {
    const byCat = {};
    grants.forEach(g => { const c = g.category || "Other"; byCat[c] = (byCat[c] || 0) + g.amount; });
    const catData = Object.entries(byCat).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
    const totalAll = catData.reduce((s, c) => s + c.value, 0);
    const top = catData[0] || null;
    let topSeries = [];
    if (top) {
      const byYear = {};
      grants.filter(g => (g.category || "Other") === top.name).forEach(g => { byYear[g.year] = (byYear[g.year] || 0) + g.amount; });
      topSeries = Object.entries(byYear).map(([year, amount]) => ({ year: Number(year), amount })).sort((a, b) => a.year - b.year);
    }
    return { catData, totalAll, top, topSeries };
  }, [grants]);
  const topCount = top ? grants.filter(g => (g.category || "Other") === top.name).length : 0;
  const topYears = topSeries.length ? topSeries[0].year + "–" + topSeries[topSeries.length - 1].year : "";
  const topPct = top && totalAll ? Math.round((top.value / totalAll) * 100) : 0;

  // Distinct-grantee counts over time. Grants are recorded by year only (no exact
  // dates), so "last 5 years" = the last 5 calendar years and "trailing 12 months"
  // is approximated by the current calendar year.
  const { cntAll, cnt5, cnt5Span, cnt12, curYear } = useMemo(() => {
    const curYear = new Date().getFullYear();
    const distinctSince = startYear => new Set(grants.filter(g => g.year >= startYear).map(g => normalizeOrg(g.org))).size;
    return {
      curYear,
      cntAll: index.length,
      cnt5: distinctSince(curYear - 4),
      cnt5Span: (curYear - 4) + "–" + curYear,
      cnt12: distinctSince(curYear),
    };
  }, [grants, index]);

  return (
    <div style={{ maxWidth: 1140, margin: "0 auto", padding: narrow ? "28px 16px" : "36px 40px" }}>
      <SectionTitle title="Grantees" sub={index.length + " organizations, ranked by total support received"} />

      <div style={{ display: "grid", gridTemplateColumns: narrow ? "1fr" : "repeat(3, minmax(0,1fr))", gap: 16, marginBottom: 16 }}>
        <StatCard label="Grantees, all-time" value={cntAll} sub="organizations supported since 2001" accent={TEAL} />
        <StatCard label="Active, last 5 years" value={cnt5} sub={"organizations · " + cnt5Span} accent={CORAL} />
        <StatCard label="Active, trailing 12 months" value={cnt12} sub={"organizations · " + curYear + " grant cycle"} accent={SUN} />
      </div>

      {top && (
        <div style={{ display: "grid", gridTemplateColumns: narrow ? "1fr" : "minmax(0,1.35fr) minmax(0,1fr)", gap: 16, marginBottom: 26 }}>
          {/* Donut — areas of giving */}
          <Card style={{ padding: narrow ? 18 : 24 }}>
            <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 18, marginBottom: 4 }}>Areas of Giving</div>
            <div style={{ fontSize: 12, color: "#7C8C8A", marginBottom: 14 }}>{fmt(totalAll)} across {catData.length} focus areas, all years</div>
            <div style={{ display: "grid", gridTemplateColumns: narrow ? "1fr" : "minmax(0,1fr) minmax(0,1fr)", gap: 8, alignItems: "center" }}>
              <div style={{ height: 230 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={catData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={55} outerRadius={92} paddingAngle={2} isAnimationActive={false}>
                      {catData.map(entry => <Cell key={entry.name} fill={CAT_COLORS[entry.name] || "#999"} />)}
                    </Pie>
                    <Tooltip formatter={v => fmt(v)} contentStyle={{ fontFamily: FONT_BODY, fontSize: 13 }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {catData.map(c => {
                  const pct = totalAll ? Math.round((c.value / totalAll) * 100) : 0;
                  return (
                    <div key={c.name} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 3, background: CAT_COLORS[c.name] || "#999", flexShrink: 0 }} />
                      <span style={{ color: INK, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                      <span style={{ color: "#7C8C8A", whiteSpace: "nowrap" }}>{fmtK(c.value)} <span style={{ fontSize: 11 }}>({pct}%)</span></span>
                    </div>
                  );
                })}
              </div>
            </div>
          </Card>

          {/* Top area over time tile */}
          <Card style={{ padding: narrow ? 18 : 24, display: "flex", flexDirection: "column", background: "linear-gradient(160deg,#FFFDF9,#FBF4EC)" }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "#A8B8B8" }}>Top area of giving</div>
            <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: narrow ? 22 : 25, color: CAT_COLORS[top.name] || TEAL, lineHeight: 1.15, marginTop: 6 }}>{top.name}</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
              <span style={{ fontFamily: FONT_DISPLAY, fontWeight: 700, fontSize: 30, color: TEAL }}>{fmtK(top.value)}</span>
              <span style={{ fontSize: 13, color: "#7C8C8A" }}>{topPct}% of all giving</span>
            </div>
            <div style={{ fontSize: 12.5, color: "#7C8C8A", marginTop: 4 }}>{topCount} grant{topCount > 1 ? "s" : ""} &middot; {topYears}</div>
            <div style={{ flex: 1, minHeight: 90, marginTop: 14 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={topSeries} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                  <defs>
                    <linearGradient id="topAreaFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={CAT_COLORS[top.name] || TEAL} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={CAT_COLORS[top.name] || TEAL} stopOpacity={0.03} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="year" tick={{ fontFamily: FONT_BODY, fontSize: 10, fill: "#A8B8B8" }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                  <Tooltip formatter={v => fmt(v)} labelFormatter={l => "Year " + l} contentStyle={{ fontFamily: FONT_BODY, fontSize: 12 }} />
                  <Area type="monotone" dataKey="amount" stroke={CAT_COLORS[top.name] || TEAL} strokeWidth={2.5} fill="url(#topAreaFill)" isAnimationActive={false} dot={{ r: 2.5, fill: CAT_COLORS[top.name] || TEAL }} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </div>
      )}

      <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search organizations..." style={{
        width: "100%", maxWidth: 380, border: "1px solid #E2D7C9", borderRadius: 8, padding: "10px 14px",
        fontSize: 14, fontFamily: "'Nunito Sans', sans-serif", color: "#1F3A38", background: "#FBF4EC", marginBottom: 22,
      }} />
      <div style={{ display: "grid", gridTemplateColumns: narrow ? "1fr" : "repeat(auto-fill, minmax(320px, 1fr))", gap: 12 }}>
        {list.map((o, i) => {
          const c = CAT_COLORS[o.category] || "#999";
          return (
            <button key={o.org} onClick={() => goGrantee(o.org)} style={{
              textAlign: "left", background: "#fff", border: "1px solid #EFE7DD", borderLeft: "4px solid " + c,
              borderRadius: 10, padding: "16px 18px", cursor: "pointer", fontFamily: "'Nunito Sans', sans-serif",
              display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12,
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 11, color: "#A8B8B8", fontWeight: 600 }}>#{i + 1}</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#1F3A38", lineHeight: 1.25 }}>{nameOf(o)}</div>
                <div style={{ fontSize: 12, color: "#7C8C8A", marginTop: 4 }}>{o.count} grant{o.count > 1 ? "s" : ""} &middot; {o.firstYear}&ndash;{o.lastYear}</div>
                {(() => {
                  const dd = diligenceFor(granteeNotes[o.org], (granteeDocs || {})[o.org]);
                  if (dd.done === dd.total) return <div style={{ display: "inline-block", marginTop: 6, fontSize: 10.5, fontWeight: 800, color: "#0E7A5F", background: "#EAF7F2", borderRadius: 20, padding: "1px 8px" }}>✓ Verified file</div>;
                  if (!(o.lastYear >= recentYear)) return null;
                  return <div style={{ display: "inline-block", marginTop: 6, fontSize: 10.5, fontWeight: 800, color: "#9A7B1E", background: "#FFF6E5", borderRadius: 20, padding: "1px 8px" }}>Needs file · {dd.done} of {dd.total}</div>;
                })()}
              </div>
              <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                <div style={{ fontFamily: "'Fredoka', serif", fontWeight: 700, fontSize: 20, color: TEAL }}>{fmtK(o.total)}</div>
                <div style={{ fontSize: 10, color: c, fontWeight: 600, marginTop: 2 }}>{o.category}</div>
              </div>
            </button>
          );
        })}
        {list.length === 0 && <div style={{ color: "#7C8C8A", padding: 20 }}>No organizations match &ldquo;{q}&rdquo;.</div>}
      </div>
    </div>
  );
}

const fmtDate = s => { try { return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); } catch { return ""; } };

// Inline editor for a grantee's profile (website, contact, description).
function GranteeProfileEditor({ org, note, exists, onDone }) {
  const { session, setSession } = useAuth();
  const { refresh } = useData();
  const [f, setF] = useState({
    display_name: note?.displayName || "", website: note?.website || "",
    contact: note?.contact || "", contact_role: note?.contactRole || "",
    contact_email: note?.contactEmail || "", community: note?.community || "",
    description: note?.description || "", mailing_address: note?.mailingAddress || "",
    phone: note?.phone || "", ein: note?.ein || "",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k, v) => setF({ ...f, [k]: v });

  async function save() {
    setBusy(true); setErr("");
    const payload = {};
    Object.keys(f).forEach(k => { payload[k] = f[k].trim() === "" ? null : f[k].trim(); });
    try {
      if (exists) await authedWrite(session, setSession, "PATCH", "grantee_notes?org=eq." + encodeURIComponent(org), payload);
      else await authedWrite(session, setSession, "POST", "grantee_notes", { org, ...payload });
      await refresh(); onDone();
    } catch (e) { setErr(e.message); setBusy(false); }
  }

  const fld = (label, key, ph) => (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontFamily: FONT_BODY, fontWeight: 700, fontSize: 12, color: INK, marginBottom: 4 }}>{label}</div>
      <input value={f[key]} onChange={e => set(key, e.target.value)} placeholder={ph} style={{ ...formInput, fontSize: 14, padding: "9px 12px" }} />
    </div>
  );

  return (
    <Card style={{ padding: 22, marginBottom: 24, background: "#FBF4EC" }}>
      <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 18, marginBottom: 14 }}>Edit profile</div>
      {fld("Display name", "display_name", "Full organization name")}
      {fld("Website", "website", "https://…")}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        {fld("Key contact", "contact", "Name")}
        {fld("Contact role", "contact_role", "e.g. Executive Director")}
        {fld("Contact email", "contact_email", "name@org.org")}
        {fld("Home community", "community", "e.g. Port Austin, MI")}
        {fld("Phone", "phone", "772.562.9860")}
        {fld("EIN", "ein", "65-0017325")}
      </div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontFamily: FONT_BODY, fontWeight: 700, fontSize: 12, color: INK, marginBottom: 4 }}>Mailing address</div>
        <div style={{ fontSize: 11.5, color: "#9B8E80", marginBottom: 4 }}>As it should appear on a mailed letter — one line per line.</div>
        <textarea value={f.mailing_address} onChange={e => set("mailing_address", e.target.value)} rows={3} placeholder={"273 Dearborn Court\nGeneva, IL 60134"} style={{ ...formInput, fontSize: 14, padding: "9px 12px", resize: "vertical" }} />
      </div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontFamily: FONT_BODY, fontWeight: 700, fontSize: 12, color: INK, marginBottom: 4 }}>Description</div>
        <textarea value={f.description} onChange={e => set("description", e.target.value)} rows={3} placeholder="What this organization does" style={{ ...formInput, fontSize: 14, padding: "9px 12px", resize: "vertical" }} />
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <MiniButton kind="save" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save profile"}</MiniButton>
        <MiniButton kind="cancel" onClick={onDone} disabled={busy}>Cancel</MiniButton>
      </div>
      {err && <div style={{ color: "#B5451B", fontSize: 12, marginTop: 8 }}>{err}</div>}
    </Card>
  );
}

// Composer to post a dated update with photos.
function UpdateComposer({ org, onDone }) {
  const { session, setSession } = useAuth();
  const { refresh } = useData();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function post() {
    if (!body.trim() && !title.trim() && files.length === 0) { setErr("Add a note or a file."); return; }
    setBusy(true); setErr("");
    try {
      const atts = [];
      for (const file of files) atts.push(await uploadFile(session, file, org));
      await authedWrite(session, setSession, "POST", "grantee_updates", {
        org, title: title.trim() || null, body: body.trim() || null,
        author: session.email, photos: atts,
      });
      await refresh(); onDone();
    } catch (e) { setErr(e.message); setBusy(false); }
  }

  return (
    <Card style={{ padding: 22, marginBottom: 18, background: "#FBF4EC" }}>
      <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 18, marginBottom: 12 }}>Post an update</div>
      <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Title (optional)" style={{ ...formInput, fontSize: 14, padding: "9px 12px", marginBottom: 10 }} />
      <textarea value={body} onChange={e => setBody(e.target.value)} rows={3} placeholder="What's the latest with this grantee?" style={{ ...formInput, fontSize: 14, padding: "9px 12px", resize: "vertical", marginBottom: 10 }} />
      <input type="file" accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv" multiple onChange={e => setFiles(Array.from(e.target.files || []))} style={{ fontSize: 13, fontFamily: FONT_BODY, marginBottom: 6 }} />
      <div style={{ fontSize: 12, color: "#9B8E80", marginBottom: 6 }}>Photos, PDFs, or documents — attach as many as you like.</div>
      {files.length > 0 && <div style={{ fontSize: 12, color: "#7C8C8A", marginBottom: 10 }}>{files.length} file{files.length > 1 ? "s" : ""} selected</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
        <MiniButton kind="save" onClick={post} disabled={busy}>{busy ? "Posting…" : "Post update"}</MiniButton>
        <MiniButton kind="cancel" onClick={onDone} disabled={busy}>Cancel</MiniButton>
      </div>
      {err && <div style={{ color: "#B5451B", fontSize: 12, marginTop: 8 }}>{err}</div>}
    </Card>
  );
}

// Format a single metric value, respecting its unit ($ vs. count).
function fmtMetric(value, unit) {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (unit === "$") return fmt(n);
  return n.toLocaleString() + (unit && unit !== "$" ? " " + unit : "");
}

// Editor for a single program: name, purpose, and a dynamic list of metrics
// (label / unit / target / current). Used for both adding and editing.
function ProgramEditor({ org, program, onDone }) {
  const { session, setSession } = useAuth();
  const { refresh } = useData();
  const [name, setName] = useState(program?.name || "");
  const [purpose, setPurpose] = useState(program?.purpose || "");
  const [metrics, setMetrics] = useState(
    program?.metrics?.length ? program.metrics.map(m => ({ ...m })) : [{ label: "", unit: "", target: "", current: "" }]
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const setM = (i, k, v) => setMetrics(metrics.map((m, j) => j === i ? { ...m, [k]: v } : m));
  const addM = () => setMetrics([...metrics, { label: "", unit: "", target: "", current: "" }]);
  const rmM = i => setMetrics(metrics.filter((_, j) => j !== i));

  async function save() {
    if (!name.trim()) { setErr("Give the program a name."); return; }
    setBusy(true); setErr("");
    const cleanMetrics = metrics
      .filter(m => m.label.trim())
      .map(m => ({
        label: m.label.trim(),
        unit: (m.unit || "").trim(),
        target: m.target === "" || m.target === null ? null : Number(m.target),
        current: m.current === "" || m.current === null ? null : Number(m.current),
      }));
    const payload = { org, name: name.trim(), purpose: purpose.trim() || null, metrics: cleanMetrics, updated_at: new Date().toISOString() };
    try {
      if (program?.id) await authedWrite(session, setSession, "PATCH", "grantee_programs?id=eq." + program.id, payload);
      else await authedWrite(session, setSession, "POST", "grantee_programs", payload);
      await refresh(); onDone();
    } catch (e) { setErr(e.message); setBusy(false); }
  }

  async function remove() {
    if (!program?.id) return;
    if (!window.confirm("Remove this program and its tracked outcomes? This can't be undone.")) return;
    setBusy(true); setErr("");
    try {
      await authedWrite(session, setSession, "DELETE", "grantee_programs?id=eq." + program.id, null);
      await refresh(); onDone();
    } catch (e) { setErr(e.message); setBusy(false); }
  }

  const lbl = { fontFamily: FONT_BODY, fontWeight: 700, fontSize: 12, color: INK, marginBottom: 4 };
  return (
    <Card style={{ padding: 22, marginBottom: 16, background: "#FBF4EC" }}>
      <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 18, marginBottom: 14 }}>{program ? "Edit program" : "Add a program"}</div>
      <div style={{ marginBottom: 12 }}>
        <div style={lbl}>Program name</div>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Fostering Futures Program" style={{ ...formInput, fontSize: 14, padding: "9px 12px" }} />
      </div>
      <div style={{ marginBottom: 16 }}>
        <div style={lbl}>What it does</div>
        <textarea value={purpose} onChange={e => setPurpose(e.target.value)} rows={3} placeholder="A sentence or two on the program's purpose." style={{ ...formInput, fontSize: 14, padding: "9px 12px", resize: "vertical" }} />
      </div>
      <div style={{ ...lbl, fontSize: 13, marginBottom: 8 }}>Outcomes to track</div>
      <div style={{ fontSize: 12, color: "#9B8E80", marginBottom: 10 }}>Set the expectation (target) for each measure. Leave a target blank until the grantee gives us their number — fill in &ldquo;current&rdquo; as progress comes in.</div>
      {metrics.map((m, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr auto", gap: 8, marginBottom: 8, alignItems: "center" }}>
          <input value={m.label} onChange={e => setM(i, "label", e.target.value)} placeholder="Measure (e.g. Youth served)" style={{ ...formInput, fontSize: 13, padding: "8px 10px" }} />
          <input value={m.unit} onChange={e => setM(i, "unit", e.target.value)} placeholder="Unit ($, youth…)" style={{ ...formInput, fontSize: 13, padding: "8px 10px" }} />
          <input value={m.target ?? ""} onChange={e => setM(i, "target", e.target.value)} type="number" placeholder="Target" style={{ ...formInput, fontSize: 13, padding: "8px 10px" }} />
          <input value={m.current ?? ""} onChange={e => setM(i, "current", e.target.value)} type="number" placeholder="Current" style={{ ...formInput, fontSize: 13, padding: "8px 10px" }} />
          <button onClick={() => rmM(i)} title="Remove measure" style={{ background: "none", border: "none", color: "#B5451B", cursor: "pointer", fontSize: 18, lineHeight: 1, padding: "0 4px" }}>&times;</button>
        </div>
      ))}
      <button onClick={addM} style={{ background: "none", border: "1px dashed " + LINE, borderRadius: 8, color: TEAL, cursor: "pointer", fontSize: 13, fontWeight: 700, padding: "7px 12px", fontFamily: FONT_BODY, marginBottom: 16 }}>+ Add a measure</button>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <MiniButton kind="save" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save program"}</MiniButton>
        <MiniButton kind="cancel" onClick={onDone} disabled={busy}>Cancel</MiniButton>
        {program?.id && <button onClick={remove} disabled={busy} style={{ marginLeft: "auto", background: "none", border: "none", color: "#B5451B", cursor: "pointer", fontSize: 13, fontWeight: 700, fontFamily: FONT_BODY }}>Delete program</button>}
      </div>
      {err && <div style={{ color: "#B5451B", fontSize: 12, marginTop: 8 }}>{err}</div>}
    </Card>
  );
}

// Read-only card for one program: purpose + each tracked outcome as target/current.
function ProgramCard({ program, color, signedIn, onEdit, narrow }) {
  const metrics = program.metrics || [];
  return (
    <Card style={{ padding: narrow ? 20 : "24px 26px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 19, color: INK }}>{program.name}</div>
        {signedIn && <MiniButton kind="edit" onClick={onEdit}>Edit</MiniButton>}
      </div>
      {program.purpose && <div style={{ fontSize: 14, color: "#5E6E6C", lineHeight: 1.55, marginTop: 6, fontFamily: FONT_BODY }}>{program.purpose}</div>}
      {metrics.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 18 }}>
          {metrics.map((m, i) => {
            const unit = m.unit || "";
            const money = unit === "$", pctU = unit === "%";
            const fmtN = v => money ? fmt(Number(v)) : Number(v).toLocaleString() + (pctU ? "%" : "");
            const suffix = (!money && !pctU && unit) ? " " + unit : "";
            const targetNum = m.target === null || m.target === undefined || m.target === "" ? null : Number(m.target);
            const cur = m.current === null || m.current === undefined || m.current === "" ? null : Number(m.current);
            const hasTarget = targetNum !== null && targetNum > 0;
            const pct = hasTarget && cur !== null ? Math.round((cur / targetNum) * 100) : null;
            const over = pct !== null && pct > 100;
            return (
              <div key={i}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginBottom: 5 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: INK, fontFamily: FONT_BODY }}>{m.label}</span>
                  <span style={{ fontSize: 13, color: "#7C8C8A", fontFamily: FONT_BODY, whiteSpace: "nowrap" }}>
                    {hasTarget ? (
                      <><strong style={{ color: cur !== null ? color : "#B7A89A" }}>{cur !== null ? fmtN(cur) : "—"}</strong>{" "}<span style={{ fontSize: 12 }}>/ {fmtN(targetNum)}{suffix}</span></>
                    ) : cur !== null ? (
                      <><strong style={{ color }}>{fmtN(cur)}{suffix}</strong>{" "}<span style={{ fontSize: 12, color: "#9B8E80" }}>&middot; tracked</span></>
                    ) : (
                      <span style={{ color: "#B7A89A" }}>target TBD</span>
                    )}
                  </span>
                </div>
                <div style={{ height: 7, background: "#F3ECE3", borderRadius: 4, overflow: "hidden" }}>
                  {pct !== null
                    ? <div style={{ height: 7, width: Math.min(100, pct) + "%", background: over ? CORAL : color, borderRadius: 4 }} />
                    : <div style={{ height: 7, width: "100%", background: "repeating-linear-gradient(90deg," + LINE + "," + LINE + " 5px,transparent 5px,transparent 10px)" }} />}
                </div>
                {pct !== null && <div style={{ fontSize: 11, color: over ? CORAL : "#9B8E80", marginTop: 3, fontFamily: FONT_BODY }}>{over ? "Above plan (" + pct + "%)" : pct + "% of target"}</div>}
              </div>
            );
          })}
        </div>
      )}
      {metrics.length === 0 && <div style={{ fontSize: 13, color: "#9B8E80", marginTop: 12, fontFamily: FONT_BODY, fontStyle: "italic" }}>No outcomes set yet.</div>}
    </Card>
  );
}

// The shared Kendacar outcomes block — same purpose line and four measures on every youth grantee.
function CoreOutcomesCard({ outcomes, signedIn, onEdit, narrow }) {
  const served = outcomes && outcomes.served != null && outcomes.served !== "" ? Number(outcomes.served) : null;
  return (
    <div style={{ background: "linear-gradient(160deg,#FFFDF9,#F6FBFA)", border: "1px solid " + LINE, borderTop: "4px solid " + TEAL, borderRadius: 18, padding: narrow ? 20 : "26px 30px", marginBottom: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase", color: TEAL, fontFamily: FONT_BODY }}>Kendacar Core Outcomes</div>
          <div style={{ fontFamily: FONT_ACCENT, fontSize: narrow ? 22 : 26, color: INK, lineHeight: 1.2, marginTop: 6, maxWidth: 760 }}>{SHARED_PURPOSE}</div>
        </div>
        {signedIn && <MiniButton kind="edit" onClick={onEdit}>{outcomes ? "Edit" : "Add numbers"}</MiniButton>}
      </div>
      <div style={{ fontSize: 12.5, color: "#7C8C8A", fontFamily: FONT_BODY, margin: "12px 0 18px", maxWidth: 760 }}>
        The same four measures every Kendacar youth grantee reports — so the focus stays on whether young people are making it, and the organizations are working toward one goal together.
        {served != null && <> <strong style={{ color: INK }}>{served.toLocaleString()} young people</strong> served in scope.</>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: narrow ? "1fr" : "1fr 1fr", gap: narrow ? 14 : "16px 28px" }}>
        {CORE_OUTCOMES.map(o => {
          const reached = outcomes && outcomes[o.key] != null && outcomes[o.key] !== "" ? Number(outcomes[o.key]) : null;
          const pct = served && served > 0 && reached != null ? Math.round((reached / served) * 100) : null;
          return (
            <div key={o.key}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: INK, fontFamily: FONT_BODY }}>{o.label}</span>
                <span style={{ fontSize: 13, color: "#7C8C8A", fontFamily: FONT_BODY, whiteSpace: "nowrap" }}>
                  {reached != null
                    ? <><strong style={{ color: o.color }}>{reached.toLocaleString()}</strong>{served != null && <> of {served.toLocaleString()}{pct != null && <> &middot; {pct}%</>}</>}</>
                    : <span style={{ color: "#B7A89A" }}>awaiting report</span>}
                </span>
              </div>
              <div style={{ fontSize: 11.5, color: "#9B8E80", fontFamily: FONT_BODY, margin: "2px 0 6px" }}>{o.blurb}</div>
              <div style={{ height: 7, background: "#EEE7DD", borderRadius: 4, overflow: "hidden" }}>
                {pct != null
                  ? <div style={{ height: 7, width: Math.min(100, pct) + "%", background: o.color, borderRadius: 4 }} />
                  : <div style={{ height: 7, width: "100%", background: "repeating-linear-gradient(90deg," + LINE + "," + LINE + " 5px,transparent 5px,transparent 10px)" }} />}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Editor for the shared core-outcomes numbers (served + one count per outcome).
function CoreOutcomesEditor({ org, note, onDone }) {
  const { session, setSession } = useAuth();
  const { refresh } = useData();
  const existing = note?.coreOutcomes || {};
  const [served, setServed] = useState(existing.served ?? "");
  const [vals, setVals] = useState(() => Object.fromEntries(CORE_OUTCOMES.map(o => [o.key, existing[o.key] ?? ""])));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const num = v => v === "" || v === null ? null : Number(v);

  async function save() {
    setBusy(true); setErr("");
    const payload = { served: num(served) };
    CORE_OUTCOMES.forEach(o => { payload[o.key] = num(vals[o.key]); });
    try {
      if (note) await authedWrite(session, setSession, "PATCH", "grantee_notes?org=eq." + encodeURIComponent(org), { core_outcomes: payload });
      else await authedWrite(session, setSession, "POST", "grantee_notes", { org, core_outcomes: payload });
      await refresh(); onDone();
    } catch (e) { setErr(e.message); setBusy(false); }
  }

  const fieldStyle = { ...formInput, fontSize: 14, padding: "8px 10px" };
  return (
    <Card style={{ padding: 22, marginBottom: 16, background: "#FBF4EC" }}>
      <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 18, marginBottom: 4 }}>Kendacar Core Outcomes</div>
      <div style={{ fontSize: 12.5, color: "#7C8C8A", marginBottom: 14 }}>Enter how many young people are served in scope, then how many have reached each outcome. Leave blank where you don&rsquo;t have a number yet.</div>
      <div style={{ marginBottom: 14, maxWidth: 280 }}>
        <div style={{ fontFamily: FONT_BODY, fontWeight: 700, fontSize: 12, color: INK, marginBottom: 4 }}>Young people served (in scope)</div>
        <input value={served} onChange={e => setServed(e.target.value)} type="number" placeholder="e.g. 35" style={fieldStyle} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: narrowGrid(), gap: 12 }}>
        {CORE_OUTCOMES.map(o => (
          <div key={o.key}>
            <div style={{ fontFamily: FONT_BODY, fontWeight: 700, fontSize: 12, color: INK, marginBottom: 4 }}>{o.label} <span style={{ fontWeight: 400, color: "#9B8E80" }}>— # reached</span></div>
            <input value={vals[o.key]} onChange={e => setVals({ ...vals, [o.key]: e.target.value })} type="number" placeholder="#" style={fieldStyle} />
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <MiniButton kind="save" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save outcomes"}</MiniButton>
        <MiniButton kind="cancel" onClick={onDone} disabled={busy}>Cancel</MiniButton>
      </div>
      {err && <div style={{ color: "#B5451B", fontSize: 12, marginTop: 8 }}>{err}</div>}
    </Card>
  );
}
function narrowGrid() { return "repeat(2, minmax(0,1fr))"; }

// =============================================================================
//  WORD DOCUMENT GENERATION
//  Real .docx files built in the browser so they open editable in Word.
//  The docx library is imported on demand to keep it out of the main bundle.
// =============================================================================

const FOUNDATION = {
  name: "Kendacar Foundation, Inc.",
  addressLines: ["627 Leonard Pkwy.", "Crystal Lake, IL   60014"],
  inlineAddress: "627 Leonard Pkwy, Crystal Lake, IL 60014",
};

// Who can sign. Contact details appear in the letter's "reach out to me" line.
const SIGNERS = [
  { name: "Carlie Dobbeck",    title: "Trustee",   email: "cdobbeck@gmail.com", phone: "(815)355-6882" },
  { name: "Christine Smith",   title: "President", email: "pabsmith28@gmail.com", phone: "" },
  { name: "David P. Smith, III", title: "Treasurer", email: "dave.smith@compositesone.com", phone: "" },
  { name: "David P. Smith, Jr.", title: "Trustee",   email: "dp.smith@stantine.com", phone: "" },
  { name: "Kendra S. Rogocki", title: "Secretary", email: "kendra.rogocki@stantine.com", phone: "" },
];
const defaultSigner = email => SIGNERS.find(s => s.email && email && s.email.toLowerCase() === email.toLowerCase()) || SIGNERS[0];

const MONTHS_FULL = ["January","February","March","April","May","June","July","August","September","October","November","December"];
// "2026-01-05" -> "January 5, 2026"
const fmtLetterDate = s => {
  if (!s) return "";
  const p = String(s).split("-");
  if (p.length !== 3) return String(s);
  return MONTHS_FULL[Number(p[1]) - 1] + " " + Number(p[2]) + ", " + p[0];
};

// The foundation name ends in "Inc." — avoid doubling the period when it closes a sentence.
const endSentence = t => (/[.!?]$/.test(t) ? t : t + ".");

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// The cover letter that goes out with a grant check.
async function generateGrantLetter({ grant, note, signer }) {
  const { Document, Packer, Paragraph, TextRun, AlignmentType } = await import("docx");
  const P = t => new Paragraph({ children: [new TextRun(t || "")] });
  // The letterhead is centred, as it is on the letters these are modelled on.
  const C = t => new Paragraph({ children: [new TextRun(t || "")], alignment: AlignmentType.CENTER });
  const orgName = (note && note.displayName) || grant.org;
  const addrLines = String((note && note.mailingAddress) || "").split("\n").map(l => l.trim()).filter(Boolean);
  // Fall back to the foundation's standing contact if this signer has none on file.
  const c = (signer.phone || signer.email) ? signer : SIGNERS[0];
  const reach = [c.phone, c.email].filter(Boolean).join(" or ");
  const dated = grant.checkDate || new Date().toISOString().slice(0, 10);

  const kids = [];
  kids.push(C(FOUNDATION.name));
  FOUNDATION.addressLines.forEach(l => kids.push(C(l)));
  kids.push(P(""));
  kids.push(P(fmtLetterDate(dated)));
  kids.push(P(""));
  kids.push(P(orgName));
  if (note && note.contact) kids.push(P("Attn: " + note.contact));
  addrLines.forEach(l => kids.push(P(l)));
  kids.push(P(""));
  kids.push(P("Dear " + orgName + ","));
  kids.push(P(""));
  kids.push(P("Please see the enclosed donation of " + fmt(grant.amount) + " from " + endSentence(FOUNDATION.name) +
    "  We are happy to support your organization, knowing that it is such an important part of our community."));
  kids.push(P(""));
  kids.push(P("We would greatly appreciate the receipt for the donation to be sent to " + FOUNDATION.inlineAddress +
    ".  Please be sure to note the donation was provided by " + endSentence(FOUNDATION.name) +
    (reach ? " Please reach out to me with any questions at " + reach + "." : "")));
  kids.push(P(""));
  kids.push(P("Sincerely,"));
  kids.push(P("")); kids.push(P(""));
  kids.push(P(signer.name));
  kids.push(P(signer.title));

  const doc = new Document({
    styles: { default: { document: { run: { font: "Georgia", size: 22 } } } },
    sections: [{ children: kids }],
  });
  downloadBlob(await Packer.toBlob(doc), grant.year + "_Kendacar Foundation Letter to " + orgName + ".docx");
}

// Upload or open the acknowledgment a grantee mails back for a grant.
function GrantReceiptButton({ grant, docs, onChange, readOnly }) {
  const { session, setSession } = useAuth();
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const doc = (docs || [])[0];

  async function pick(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    try {
      const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, "_");
      const path = grant.id + "/" + Date.now() + "_" + safe;
      await uploadPrivateDoc(session, setSession, path, file);
      await authedWrite(session, setSession, "POST", "grant_documents", {
        grant_id: grant.id, kind: "receipt", storage_path: path,
        filename: file.name, content_type: file.type || null,
      });
      if (doc) {
        try { await deletePrivateDoc(session, setSession, doc.storage_path); } catch { /* row still goes */ }
        await authedWrite(session, setSession, "DELETE", "grant_documents?id=eq." + doc.id);
      }
      if (onChange) await onChange();
    } catch (err) { alert("Upload failed: " + err.message); }
    finally { setBusy(false); }
  }

  async function open() {
    setBusy(true);
    try { window.open(await signedDocUrl(session, setSession, doc.storage_path), "_blank", "noopener"); }
    catch (err) { alert(err.message); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!window.confirm("Remove \"" + (doc.filename || "this document") + "\" from " + grant.org + "?" +
      "\n\nThe grant stays; only the attached document is deleted.")) return;
    setBusy(true);
    try {
      await deletePrivateDoc(session, setSession, doc.storage_path);
      await authedWrite(session, setSession, "DELETE", "grant_documents?id=eq." + doc.id);
      if (onChange) await onChange();
    } catch (err) { alert(err.message); }
    finally { setBusy(false); }
  }

  if (readOnly) {
    return doc
      ? <MiniButton kind="save" onClick={open} disabled={busy} title="Open the acknowledgment this organization sent back">{busy ? "…" : "✓ Receipt from org"}</MiniButton>
      : <span style={{ fontSize: 11.5, color: "#C8BBA8" }}>not yet received</span>;
  }
  return (
    <>
      <input ref={fileRef} type="file" onChange={pick} style={{ display: "none" }}
             accept=".pdf,.png,.jpg,.jpeg,.heic,.doc,.docx" />
      {doc
        ? <>
            <MiniButton kind="save" onClick={open} disabled={busy} title="Open the acknowledgment this organization sent back">{busy ? "…" : "✓ Receipt from org"}</MiniButton>
            <button onClick={() => fileRef.current && fileRef.current.click()} disabled={busy} style={subAction(false)} title="Upload a different file in its place">Replace</button>
            <button onClick={remove} disabled={busy} style={subAction(true)} title="Delete this attachment">Remove</button>
          </>
        : <MiniButton kind="cancel" onClick={() => fileRef.current && fileRef.current.click()} disabled={busy}>
            {busy ? "Uploading…" : "Attach receipt from org"}
          </MiniButton>}
    </>
  );
}

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// Replace / Remove are secondary — quiet links keep the row narrow and the hierarchy honest.
const subAction = danger => ({
  background: "none", border: "none", padding: "0 2px", cursor: "pointer",
  color: danger ? "#B5451B" : "#7C8C8A", fontSize: 11.5, fontFamily: FONT_BODY,
  textDecoration: "underline", whiteSpace: "nowrap",
});

// Upload or open the receipt filed against a gift.
function GiftDocButton({ gift, docs, onChange, readOnly }) {
  const { session, setSession } = useAuth();
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const doc = (docs || [])[0];

  async function pick(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    try {
      const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, "_");
      const path = "gifts/" + gift.id + "/" + Date.now() + "_" + safe;
      await uploadPrivateDoc(session, setSession, path, file);
      await authedWrite(session, setSession, "POST", "gift_documents", {
        gift_id: gift.id, kind: "receipt", storage_path: path,
        filename: file.name, content_type: file.type || null,
      });
      if (doc) {
        try { await deletePrivateDoc(session, setSession, doc.storage_path); } catch { /* row still goes */ }
        await authedWrite(session, setSession, "DELETE", "gift_documents?id=eq." + doc.id);
      }
      if (onChange) await onChange();
    } catch (err) { alert("Upload failed: " + err.message); }
    finally { setBusy(false); }
  }
  async function open() {
    setBusy(true);
    try { window.open(await signedDocUrl(session, setSession, doc.storage_path), "_blank", "noopener"); }
    catch (err) { alert(err.message); }
    finally { setBusy(false); }
  }
  if (readOnly) {
    return doc ? <MiniButton kind="save" onClick={open} disabled={busy}>{busy ? "…" : "✓ On file"}</MiniButton> : null;
  }
  return (
    <>
      <input ref={fileRef} type="file" onChange={pick} style={{ display: "none" }}
             accept=".pdf,.doc,.docx,.png,.jpg,.jpeg" />
      {doc
        ? <>
            <MiniButton kind="save" onClick={open} disabled={busy}>{busy ? "…" : "✓ On file"}</MiniButton>
            <button onClick={() => fileRef.current && fileRef.current.click()} disabled={busy} style={subAction(false)} title="Upload a different file in its place">Replace</button>
          </>
        : <MiniButton kind="cancel" onClick={() => fileRef.current && fileRef.current.click()} disabled={busy}>
            {busy ? "…" : "Attach signed copy"}
          </MiniButton>}
    </>
  );
}

// Donor receipts keep their own letterhead wording ("Inc." without the comma).
const RECEIPT_FOUNDATION = {
  name: "Kendacar Foundation Inc.",
  addressLines: ["627 Leonard Pkwy.", "Crystal Lake, IL   60014"],
};
// Receipts state exact figures — never round a number a donor files with their taxes.
const fmtMoney2 = n => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// The acknowledgment a donor keeps for their own tax records.
async function generateDonorReceipt({ gift, signer, receiptDate }) {
  const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle } = await import("docx");
  const P = t => new Paragraph({ children: [new TextRun(t || "")] });
  const C = t => new Paragraph({ children: [new TextRun(t || "")], alignment: AlignmentType.CENTER });
  const addr = String(gift.donorAddress || "").split("\n").map(l => l.trim()).filter(Boolean);
  const greeting = gift.donorGreeting || gift.donorFormal || gift.donor;
  const isSec = gift.giftType === "securities" && (gift.securities || []).length > 0;

  const kids = [];
  kids.push(C(RECEIPT_FOUNDATION.name));
  RECEIPT_FOUNDATION.addressLines.forEach(l => kids.push(C(l)));
  kids.push(P(""));
  kids.push(P(fmtLetterDate(receiptDate)));
  kids.push(P(""));
  if (gift.donorFormal) kids.push(P(gift.donorFormal));
  addr.forEach(l => kids.push(P(l)));
  kids.push(P(""));
  kids.push(P("Dear " + greeting + ","));
  kids.push(P(""));

  if (isSec) {
    kids.push(P("Thank you for your gift on " + fmtLetterDate(gift.giftDate) +
      ", as shown below for a total market value of " + fmt(gift.amount) + " to Kendacar Foundation."));
    kids.push(P(""));
    const cell = (t, bold) => new TableCell({
      width: { size: 33, type: WidthType.PERCENTAGE },
      children: [new Paragraph({ children: [new TextRun({ text: t, bold: !!bold })] })],
    });
    const line = { style: BorderStyle.SINGLE, size: 4, color: "auto" };
    kids.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: { top: line, bottom: line, left: line, right: line, insideHorizontal: line, insideVertical: line },
      rows: [
        new TableRow({ children: [cell("Symbol", true), cell("Quantity", true), cell("Market Value", true)] }),
      ].concat(gift.securities.map(x => new TableRow({
        children: [
          cell(String(x.symbol || "")),
          cell(x.quantity != null ? Number(x.quantity).toLocaleString("en-US") : ""),
          cell(fmtMoney2(x.market_value || 0)),
        ],
      }))),
    }));
    kids.push(P(""));
  } else {
    kids.push(P("Thank you for your gift on " + fmtLetterDate(gift.giftDate) +
      " of " + fmt(gift.amount) + " in cash to Kendacar Foundation."));
    kids.push(P(""));
  }

  kids.push(P(RECEIPT_FOUNDATION.name + " is a 501(c)3 organization and your gift is tax deductible."));
  kids.push(P(""));
  kids.push(P("Sincerely,"));
  kids.push(P("")); kids.push(P(""));
  kids.push(P(signer.name));
  kids.push(P(signer.title));

  const doc = new Document({
    styles: { default: { document: { run: { font: "Georgia", size: 22 } } } },
    sections: [{ children: kids }],
  });
  const stamp = String(gift.giftDate || "").replace(/-/g, "");
  const filename = stamp + "_Kendacar " + gift.donor + " Donation Receipt.docx";
  const blob = await Packer.toBlob(doc);
  downloadBlob(blob, filename);
  return { blob, filename };
}

// Generates the receipt for one gift and stamps it as receipted.
function GiftReceiptButton({ gift, signer, onDone }) {
  const { session, setSession } = useAuth();
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      const when = gift.receiptDate || new Date().toISOString().slice(0, 10);
      await generateDonorReceipt({ gift, signer: signer || SIGNERS[0], receiptDate: when });
      if (!gift.receiptDate) {
        await authedWrite(session, setSession, "PATCH", "contribution_gifts?id=eq." + gift.id, { receipt_date: when });
      }
      if (onDone) await onDone();
    } catch (e) { alert("Couldn't build the receipt: " + e.message); }
    finally { setBusy(false); }
  }
  return <MiniButton kind="edit" onClick={go} disabled={busy}>{busy ? "…" : (gift.receiptDate ? "Regenerate →" : "Receipt for donor →")}</MiniButton>;
}

// Link straight to a tax year's Drive folder, so a preparer isn't hunting for paperwork.
function TaxFolderLink({ year, url, onChange, compact, readOnly }) {
  const { session, setSession } = useAuth();
  const [busy, setBusy] = useState(false);
  async function edit() {
    const next = window.prompt("Google Drive folder link for " + year + " (leave blank to remove):", url || "");
    if (next === null) return;
    const v = next.trim();
    setBusy(true);
    try {
      if (!v) await authedWrite(session, setSession, "DELETE", "tax_year_folders?year=eq." + year);
      else if (url) await authedWrite(session, setSession, "PATCH", "tax_year_folders?year=eq." + year, { url: v, updated_at: new Date().toISOString() });
      else await authedWrite(session, setSession, "POST", "tax_year_folders", { year, url: v });
      if (onChange) await onChange();
    } catch (e) { alert(e.message); }
    finally { setBusy(false); }
  }
  const linkStyle = { color: TEAL, fontWeight: 700, fontSize: compact ? 11.5 : 12.5, textDecoration: "none", fontFamily: FONT_BODY };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      {url && (
        <a href={url} target="_blank" rel="noopener noreferrer" style={linkStyle}
           title={"Open the " + year + " folder in Google Drive"}>
          {year} tax folder &rarr;
        </a>
      )}
      {!readOnly && <button onClick={edit} disabled={busy} style={{
        background: "none", border: "none", padding: 0, cursor: busy ? "default" : "pointer",
        color: "#9B8E80", fontSize: compact ? 11 : 11.5, fontFamily: FONT_BODY, textDecoration: "underline",
      }}>{busy ? "…" : (url ? "edit" : "+ add " + year + " folder link")}</button>}
    </span>
  );
}

// Small button that generates the cover letter for one grant.
function GrantLetterButton({ grant, signer }) {
  const { granteeNotes } = useData();
  const [busy, setBusy] = useState(false);
  const note = granteeNotes[grant.org];
  async function go() {
    if (!note || !note.mailingAddress) {
      if (!window.confirm("No mailing address on file for " + grant.org +
        ".\n\nThe letter will be generated without one — you can add the address on the grantee's page so it fills in next time.\n\nGenerate anyway?")) return;
    }
    setBusy(true);
    try { await generateGrantLetter({ grant, note, signer: signer || SIGNERS[0] }); }
    catch (e) { alert("Couldn't build the letter: " + e.message); }
    finally { setBusy(false); }
  }
  return (
    <MiniButton kind="edit" onClick={go} disabled={busy}
      title="Cover letter to print and mail in the same envelope as the check">
      {busy ? "…" : "Letter to send with check →"}
    </MiniButton>
  );
}

// Format a YYYY-MM-DD check date without timezone drift.
const fmtCheckDate = s => {
  if (!s) return "";
  const p = String(s).split("-");
  if (p.length !== 3) return String(s);
  const mo = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return mo[Number(p[1]) - 1] + " " + Number(p[2]) + ", " + p[0];
};

// One grant row in the history table, with inline check# / date editing for signed-in editors.
function GrantHistoryRow({ g, i, signedIn }) {
  const { session, setSession } = useAuth();
  const { refresh } = useData();
  const [editing, setEditing] = useState(false);
  const [cn, setCn] = useState(g.checkNumber || "");
  const [cd, setCd] = useState(g.checkDate || "");
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!g.id) { setEditing(false); return; }
    setBusy(true);
    try {
      await authedWrite(session, setSession, "PATCH", "grants?id=eq." + g.id, { check_number: cn.trim() || null, check_date: cd || null });
      await refresh(); setEditing(false);
    } catch (e) { alert(e.message); } finally { setBusy(false); }
  }
  const td = { padding: "10px 16px", borderBottom: "1px solid #F3ECE3" };
  const bg = i % 2 === 0 ? "#fff" : "#FCF7F1";
  const payment = g.checkNumber || g.checkDate
    ? (g.checkNumber ? "#" + g.checkNumber : "") + (g.checkNumber && g.checkDate ? " · " : "") + (g.checkDate ? fmtCheckDate(g.checkDate) : "")
    : "—";
  return (
    <>
      <tr style={{ background: bg }}>
        <td style={{ ...td, color: "#7C8C8A" }}>{g.year}</td>
        <td style={{ ...td, color: "#9B8E80", fontSize: 12 }}>{payment}</td>
        <td style={{ ...td, fontWeight: 700, color: TEAL, whiteSpace: "nowrap" }}>
          {fmt(g.amount)}
          {signedIn && g.id && <button onClick={() => setEditing(e => !e)} title="Edit check details" style={{ marginLeft: 8, background: "none", border: "none", color: "#B7C4C3", cursor: "pointer", fontSize: 13 }}>&#9998;</button>}
        </td>
      </tr>
      {editing && (
        <tr style={{ background: "#FBF4EC" }}>
          <td colSpan={3} style={{ padding: "10px 16px", borderBottom: "1px solid #F3ECE3" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input value={cn} onChange={e => setCn(e.target.value)} placeholder="Check #" style={{ ...formInput, fontSize: 13, padding: "6px 9px", width: 110 }} />
              <input value={cd} onChange={e => setCd(e.target.value)} type="date" style={{ ...formInput, fontSize: 13, padding: "6px 9px", width: 160 }} />
              <MiniButton kind="save" onClick={save} disabled={busy}>{busy ? "…" : "Save"}</MiniButton>
              <MiniButton kind="cancel" onClick={() => setEditing(false)} disabled={busy}>Cancel</MiniButton>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// =============================================================================
//  GRANTEE DUE DILIGENCE
//  Nothing here is required. It shows what's on file for each grantee and what's
//  still worth getting, and the processing queue warns (but doesn't block) on gaps.
// =============================================================================

const DOC_KINDS = {
  determination_letter: "IRS determination letter",
  w9: "W-9",
  irs_status_check: "IRS status check printout",
  government_letter: "Letter on government letterhead",
  other: "Other document",
};
const DOC_SLOTS = {
  charity: ["determination_letter", "w9", "irs_status_check", "other"],
  government: ["w9", "government_letter", "other"],
  other: ["w9", "other"],
};
const ORG_TYPE_LABEL = { charity: "Charity · 501(c)(3)", government: "Government unit", other: "Other organization" };
const IRS_SEARCH_URL = "https://apps.irs.gov/app/eos/";

function diligenceFor(note, docs) {
  const type = (note && note.orgType) || "charity";
  const has = kind => (docs || []).some(d => d.kind === kind);
  const items = type === "government"
    ? [
        { label: "Legal name", done: !!(note && note.legalName) },
        { label: "W-9 or government letter", done: has("w9") || has("government_letter") },
        { label: "Public purpose noted", done: !!(note && note.publicPurpose) },
      ]
    : type === "charity"
    ? [
        { label: "Legal name", done: !!(note && note.legalName) },
        { label: "EIN", done: !!(note && note.ein) },
        { label: "IRS status confirmed", done: !!(note && note.verifiedOn) },
        { label: "IRS determination letter", done: has("determination_letter"), ideal: true },
      ]
    : [
        { label: "Legal name", done: !!(note && note.legalName) },
        { label: "W-9", done: has("w9") },
      ];
  const done = items.filter(i => i.done).length;
  return { type, items, done, total: items.length, missing: items.filter(i => !i.done) };
}

// One document slot in a grantee's file: attach, open, replace, remove (family); open only (advisors).
function GranteeDocSlot({ org, kind, doc, readOnly, onChange }) {
  const { session, setSession } = useAuth();
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  async function pick(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    try {
      const slug = org.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
      const path = "grantees/" + slug + "/" + Date.now() + "_" + file.name.replace(/[^A-Za-z0-9._-]+/g, "_");
      await uploadPrivateDoc(session, setSession, path, file);
      await authedWrite(session, setSession, "POST", "grantee_documents", {
        org, kind, storage_path: path, filename: file.name, content_type: file.type || null,
      });
      if (doc) {
        try { await deletePrivateDoc(session, setSession, doc.storage_path); } catch { /* row still goes */ }
        await authedWrite(session, setSession, "DELETE", "grantee_documents?id=eq." + doc.id);
      }
      if (onChange) await onChange();
    } catch (err) { alert("Upload failed: " + err.message); }
    finally { setBusy(false); }
  }
  async function open() {
    setBusy(true);
    try { window.open(await signedDocUrl(session, setSession, doc.storage_path), "_blank", "noopener"); }
    catch (err) { alert(err.message); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!window.confirm("Remove \"" + (doc.filename || DOC_KINDS[kind]) + "\" from " + org + "'s file?")) return;
    setBusy(true);
    try {
      await deletePrivateDoc(session, setSession, doc.storage_path);
      await authedWrite(session, setSession, "DELETE", "grantee_documents?id=eq." + doc.id);
      if (onChange) await onChange();
    } catch (err) { alert(err.message); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "9px 0", borderTop: "1px solid #F3ECE3", flexWrap: "wrap" }}>
      <div style={{ fontSize: 13.5, fontFamily: FONT_BODY, color: INK, minWidth: 0 }}>
        <span style={{ color: doc ? "#1F9E6E" : "#C8BBA8", fontWeight: 800, marginRight: 8 }}>{doc ? "✓" : "–"}</span>
        {DOC_KINDS[kind]}
        {doc && <span style={{ color: "#9B8E80", fontSize: 12 }}> · {doc.filename}</span>}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input ref={fileRef} type="file" onChange={pick} style={{ display: "none" }} accept=".pdf,.png,.jpg,.jpeg,.heic,.doc,.docx" />
        {doc && <MiniButton kind="save" onClick={open} disabled={busy}>{busy ? "…" : "Open"}</MiniButton>}
        {!readOnly && (doc
          ? <>
              <button onClick={() => fileRef.current && fileRef.current.click()} disabled={busy} style={subAction(false)} title="Upload a different file in its place">Replace</button>
              <button onClick={remove} disabled={busy} style={subAction(true)} title="Delete this document">Remove</button>
            </>
          : <MiniButton kind="cancel" onClick={() => fileRef.current && fileRef.current.click()} disabled={busy}>{busy ? "Uploading…" : "Attach"}</MiniButton>)}
        {readOnly && !doc && <span style={{ fontSize: 11.5, color: "#C8BBA8" }}>not on file</span>}
      </div>
    </div>
  );
}

function DueDiligenceEditor({ org, note, onDone }) {
  const { session, setSession, email } = useAuth();
  const { refresh } = useData();
  const [f, setF] = useState({
    org_type: (note && note.orgType) || "charity",
    legal_name: (note && note.legalName) || "",
    ein: (note && note.ein) || "",
    irs_status: (note && note.irsStatus) || "",
    verified_on: (note && note.verifiedOn) || "",
    verified_by: (note && note.verifiedBy) || "",
    verification_source: (note && note.verificationSource) || "",
    public_purpose: (note && note.publicPurpose) || "",
    drive_folder_url: (note && note.driveFolderUrl) || "",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k, v) => setF({ ...f, [k]: v });
  const today = new Date().toISOString().slice(0, 10);

  async function save() {
    setBusy(true); setErr("");
    const payload = {};
    Object.keys(f).forEach(k => { payload[k] = String(f[k]).trim() === "" ? null : String(f[k]).trim(); });
    payload.org_type = f.org_type;
    try {
      if (note) await authedWrite(session, setSession, "PATCH", "grantee_notes?org=eq." + encodeURIComponent(org), payload);
      else await authedWrite(session, setSession, "POST", "grantee_notes", { org, ...payload });
      await refresh(); onDone();
    } catch (e) { setErr(e.message); setBusy(false); }
  }

  const label = t => <div style={{ fontFamily: FONT_BODY, fontWeight: 700, fontSize: 12, color: INK, marginBottom: 4 }}>{t}</div>;
  const field = (t, k, ph, type) => (
    <div style={{ marginBottom: 12 }}>
      {label(t)}
      <input type={type || "text"} value={f[k]} onChange={e => set(k, e.target.value)} placeholder={ph} style={{ ...formInput, fontSize: 14, padding: "9px 12px" }} />
    </div>
  );
  const isGov = f.org_type === "government", isCharity = f.org_type === "charity";

  return (
    <div style={{ background: "#FBF4EC", borderRadius: 14, padding: 18, marginTop: 12 }}>
      {label("Type of organization")}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        {Object.keys(ORG_TYPE_LABEL).map(t => (
          <button key={t} type="button" onClick={() => set("org_type", t)} style={{
            background: f.org_type === t ? TEAL : "#fff", color: f.org_type === t ? "#fff" : "#7C8C8A",
            border: "1px solid " + (f.org_type === t ? TEAL : "#E2D7C9"), borderRadius: 10, padding: "8px 14px",
            fontSize: 13, fontWeight: 700, fontFamily: FONT_BODY, cursor: "pointer",
          }}>{ORG_TYPE_LABEL[t]}</button>
        ))}
      </div>
      {field("Google Drive folder", "drive_folder_url", "Paste the link to this grantee's folder")}
      {field("Legal name", "legal_name", (note && note.displayName) || "Exactly as on the IRS letter or W-9")}
      {!isGov && field("EIN", "ein", "65-0017325")}
      {isCharity && field("IRS status", "irs_status", "e.g. 501(c)(3) public charity (files Form 990)")}
      {isCharity && (
        <div style={{ marginBottom: 12 }}>
          {label("Confirmed in the IRS Tax Exempt Organization Search")}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 8, alignItems: "center" }}>
            <input type="date" value={f.verified_on} onChange={e => set("verified_on", e.target.value)} style={{ ...formInput, fontSize: 14, padding: "9px 12px" }} />
            <input value={f.verified_by} onChange={e => set("verified_by", e.target.value)} placeholder="Confirmed by" style={{ ...formInput, fontSize: 14, padding: "9px 12px" }} />
            <MiniButton kind="edit" onClick={() => setF({ ...f, verified_on: today, verified_by: email })}>Mark confirmed today</MiniButton>
          </div>
          <a href={IRS_SEARCH_URL} target="_blank" rel="noopener noreferrer" style={{ display: "inline-block", marginTop: 6, color: TEAL, fontSize: 12.5, fontWeight: 700, textDecoration: "none", fontFamily: FONT_BODY }}>Open the IRS search →</a>
        </div>
      )}
      {isGov && (
        <div style={{ marginBottom: 12 }}>
          {label("Public purpose of the grant")}
          <textarea rows={2} value={f.public_purpose} onChange={e => set("public_purpose", e.target.value)} placeholder="e.g. Construction of the public pavilion for community use" style={{ ...formInput, fontSize: 14, padding: "9px 12px", resize: "vertical" }} />
        </div>
      )}
      <div style={{ marginBottom: 12 }}>
        {label("Source / notes")}
        <textarea rows={2} value={f.verification_source} onChange={e => set("verification_source", e.target.value)} placeholder="Where the status came from — a link or a note" style={{ ...formInput, fontSize: 14, padding: "9px 12px", resize: "vertical" }} />
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <MiniButton kind="save" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</MiniButton>
        <MiniButton kind="cancel" onClick={onDone} disabled={busy}>Cancel</MiniButton>
      </div>
      {err && <div style={{ color: "#B5451B", fontSize: 12, marginTop: 8 }}>{err}</div>}
    </div>
  );
}

function DueDiligenceCard({ org, note, narrow }) {
  const { signedIn } = useAuth();
  const { granteeDocs, refresh } = useData();
  const docs = (granteeDocs || {})[org] || [];
  const [editing, setEditing] = useState(false);
  const dd = diligenceFor(note, docs);
  const complete = dd.done === dd.total;
  const detail = (k, v) => v ? (
    <div style={{ display: "grid", gridTemplateColumns: "150px minmax(0,1fr)", gap: 10, padding: "5px 0", fontSize: 13.5, fontFamily: FONT_BODY }}>
      <div style={{ color: "#7C8C8A" }}>{k}</div><div style={{ color: INK, overflowWrap: "anywhere" }}>{v}</div>
    </div>
  ) : null;

  return (
    <Card style={{ padding: narrow ? 20 : 24, marginBottom: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 18 }}>Due diligence</div>
          <span style={{ background: complete ? "#EAF7F2" : "#FFF6E5", color: complete ? "#0E7A5F" : "#9A7B1E", border: "1px solid " + (complete ? "#BFE0DE" : "#F4C95D"), borderRadius: 20, padding: "2px 10px", fontSize: 11.5, fontWeight: 800 }}>
            {dd.done} of {dd.total} on file
          </span>
          <span style={{ fontSize: 12, color: "#7C8C8A" }}>{ORG_TYPE_LABEL[dd.type]}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {note && /^https:\/\//.test(note.driveFolderUrl || "") && (
            <a href={note.driveFolderUrl} target="_blank" rel="noopener noreferrer" style={{ color: TEAL, fontSize: 13, fontWeight: 700, textDecoration: "none", fontFamily: FONT_BODY }}>Drive folder ↗</a>
          )}
          {signedIn && !editing && <MiniButton kind="edit" onClick={() => setEditing(true)}>{note ? "Edit" : "Start file"}</MiniButton>}
        </div>
      </div>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 10 }}>
        {dd.items.map(i => (
          <span key={i.label} style={{ fontSize: 12.5, fontFamily: FONT_BODY, color: i.done ? "#0E7A5F" : "#9B8E80" }}>
            {i.done ? "✓" : "–"} {i.label}{!i.done && i.ideal ? " (ideal)" : ""}
          </span>
        ))}
      </div>

      {editing
        ? <DueDiligenceEditor org={org} note={note} onDone={() => setEditing(false)} />
        : (note && (note.legalName || note.ein || note.irsStatus || note.verifiedOn || note.verificationSource || note.publicPurpose)) && (
          <div style={{ marginTop: 12 }}>
            {detail("Legal name", note.legalName)}
            {detail("EIN", note.ein)}
            {detail("IRS status", note.irsStatus)}
            {detail("Confirmed", note.verifiedOn ? fmtCheckDate(note.verifiedOn) + (note.verifiedBy ? " by " + note.verifiedBy : "") : null)}
            {detail("Public purpose", note.publicPurpose)}
            {detail("Source / notes", note.verificationSource)}
          </div>
        )}

      {note
        ? <div style={{ marginTop: 12 }}>
            {DOC_SLOTS[dd.type].map(kind => (
              <GranteeDocSlot key={kind} org={org} kind={kind} doc={docs.find(d => d.kind === kind)} readOnly={!signedIn} onChange={refresh} />
            ))}
          </div>
        : <div style={{ marginTop: 12, fontSize: 13, color: "#9B8E80", fontFamily: FONT_BODY }}>
            No file yet.{signedIn ? " Start one to record the legal name, status and documents." : ""}
          </div>}
    </Card>
  );
}

function GranteeDetail({ org, setView, goGrantee, narrow }) {
  const { grants, granteeNotes, granteeUpdates, granteePrograms } = useData();
  const { signedIn, session, setSession } = useAuth();
  const { refresh } = useData();
  const index = useMemo(() => buildGranteeIndex(grants, granteeNotes), [grants, granteeNotes]);
  const rec = index.find(o => o.org === org);
  const note = granteeNotes[org];
  const updates = granteeUpdates[org] || [];
  const programs = granteePrograms[org] || [];
  const [editingProfile, setEditingProfile] = useState(false);
  const [composing, setComposing] = useState(false);
  const [editingProgram, setEditingProgram] = useState(null); // null | "new" | program object
  const [editingCore, setEditingCore] = useState(false);
  if (!rec) {
    return (
      <div style={{ maxWidth: 1140, margin: "0 auto", padding: "36px 40px" }}>
        <button onClick={() => setView("grantees")} style={{ background: "none", border: "none", color: TEAL, cursor: "pointer", fontSize: 13, fontWeight: 600, marginBottom: 16 }}>&larr; All grantees</button>
        <div style={{ color: "#7C8C8A" }}>Organization not found.</div>
      </div>
    );
  }
  const c = CAT_COLORS[rec.category] || "#999";
  const history = rec.grants.slice().sort((a, b) => a.year - b.year).map(g => ({ year: String(g.year), amount: g.amount }));
  const rank = index.findIndex(o => o.org === org) + 1;

  return (
    <div style={{ maxWidth: 1140, margin: "0 auto", padding: narrow ? "24px 16px" : "32px 40px" }}>
      <button onClick={() => setView("grantees")} style={{ background: "none", border: "none", color: TEAL, cursor: "pointer", fontSize: 13, fontWeight: 600, marginBottom: 18, fontFamily: "'Nunito Sans', sans-serif" }}>&larr; All grantees</button>

      {signedIn && editingProfile && <GranteeProfileEditor org={org} note={note} exists={!!note} onDone={() => setEditingProfile(false)} />}

      {/* Header / profile */}
      <div style={{ background: "#fff", border: "1px solid " + LINE, borderLeft: "5px solid " + c, borderRadius: 18, padding: narrow ? "22px" : "28px 32px", marginBottom: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ background: c + "18", color: c, borderRadius: 20, padding: "3px 12px", fontSize: 11, fontWeight: 700 }}>{rec.category}</span>
              {note?.community && <span style={{ background: SUN + "26", color: "#9A7B1E", borderRadius: 20, padding: "3px 12px", fontSize: 11, fontWeight: 700 }}>{note.community}</span>}
            </div>
            <h2 style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: narrow ? 26 : 32, margin: "12px 0 4px", color: INK, lineHeight: 1.05 }}>{(note && note.displayName) || rec.org}</h2>
            <div style={{ fontSize: 13, color: "#7C8C8A", fontFamily: FONT_BODY }}>{rec.pending ? "No grants yet — profile ready for the first one" : "Grantee #" + rank + " by total support · supported across " + rec.yearCount + " year" + (rec.yearCount > 1 ? "s" : "")}</div>
            {note && note.website && (
              <a href={note.website} target="_blank" rel="noopener noreferrer" style={{ display: "inline-block", marginTop: 10, color: TEAL, fontSize: 13.5, fontWeight: 700, textDecoration: "none", fontFamily: FONT_BODY }}>Visit website &rarr;</a>
            )}
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 11, fontFamily: FONT_BODY, fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase", color: "#7C8C8A" }}>Total Received</div>
            <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 40, color: TEAL, lineHeight: 1 }}>{fmt(rec.total)}</div>
            <div style={{ fontSize: 12, color: "#7C8C8A", marginTop: 4 }}>{rec.pending ? "awaiting first grant" : rec.count + " grant" + (rec.count > 1 ? "s" : "") + " · " + rec.firstYear + "–" + rec.lastYear}</div>
            {signedIn && !editingProfile && <div style={{ marginTop: 10 }}><MiniButton kind="edit" onClick={() => setEditingProfile(true)}>Edit profile</MiniButton></div>}
          </div>
        </div>
        {note && (note.description || note.contact || note.mailingAddress || note.phone) && (
          <div style={{ marginTop: 20, paddingTop: 18, borderTop: "1px solid " + LINE }}>
            {note.description && <div style={{ fontSize: 14.5, color: INK, lineHeight: 1.6, maxWidth: 740, fontFamily: FONT_BODY, marginBottom: note.contact ? 12 : 0 }}>{note.description}</div>}
            {note.contact && (
              <div style={{ fontSize: 13.5, color: "#5E6E6C", fontFamily: FONT_BODY }}>
                <strong style={{ color: INK }}>{note.contact}</strong>{note.contactRole ? " · " + note.contactRole : ""}
                {note.contactEmail && <> · <a href={"mailto:" + note.contactEmail} style={{ color: TEAL, fontWeight: 700, textDecoration: "none" }}>{note.contactEmail}</a></>}
              </div>
            )}
            {(note.mailingAddress || note.phone) && (
              <div style={{ fontSize: 13, color: "#7C8C8A", fontFamily: FONT_BODY, marginTop: 10, lineHeight: 1.5 }}>
                {String(note.mailingAddress || "").split("\n").filter(l => l.trim()).map((l, i) => <div key={i}>{l}</div>)}
                {note.phone && <div>{note.phone}</div>}
                {note.ein && <div style={{ marginTop: 4 }}>EIN <strong style={{ color: INK }}>{note.ein}</strong></div>}
              </div>
            )}
          </div>
        )}
        {signedIn && !note && !editingProfile && (
          <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px dashed " + LINE, fontSize: 13, color: "#9B8E80" }}>
            No profile yet. <button onClick={() => setEditingProfile(true)} style={{ background: "none", border: "none", color: TEAL, fontWeight: 700, cursor: "pointer", fontSize: 13 }}>Add website, contact &amp; description &rarr;</button>
          </div>
        )}
      </div>

      <DueDiligenceCard org={org} note={note} narrow={narrow} />

      {/* Shared Kendacar core outcomes — youth grantees */}
      {(YOUTH_CATEGORIES.includes(rec.category) || (note && note.coreOutcomes)) && (
        <>
          {signedIn && editingCore && <CoreOutcomesEditor org={org} note={note} onDone={() => setEditingCore(false)} />}
          {!editingCore && <CoreOutcomesCard outcomes={note && note.coreOutcomes} signedIn={signedIn} onEdit={() => setEditingCore(true)} narrow={narrow} />}
        </>
      )}

      <div style={{ display: "grid", gridTemplateColumns: narrow ? "1fr" : "1fr 1fr", gap: 20 }}>
        <Card style={{ padding: 24 }}>
          <div style={{ fontFamily: "'Fredoka', serif", fontWeight: 600, fontSize: 18, marginBottom: 20 }}>Support Over Time</div>
          <ResponsiveContainer width="100%" height={240}>
            {history.length > 1 ? (
              <LineChart data={history}>
                <CartesianGrid strokeDasharray="3 3" stroke="#F3ECE3" />
                <XAxis dataKey="year" tick={{ fontFamily: "'Nunito Sans', sans-serif", fontSize: 11 }} />
                <YAxis tickFormatter={fmtK} tick={{ fontFamily: "'Nunito Sans', sans-serif", fontSize: 11 }} />
                <Tooltip content={<CustomTooltip />} />
                <Line type="monotone" dataKey="amount" stroke={c} strokeWidth={2.5} dot={{ fill: c, r: 4 }} />
              </LineChart>
            ) : (
              <BarChart data={history}>
                <CartesianGrid strokeDasharray="3 3" stroke="#F3ECE3" />
                <XAxis dataKey="year" tick={{ fontFamily: "'Nunito Sans', sans-serif", fontSize: 11 }} />
                <YAxis tickFormatter={fmtK} tick={{ fontFamily: "'Nunito Sans', sans-serif", fontSize: 11 }} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="amount" fill={c} radius={[3, 3, 0, 0]} />
              </BarChart>
            )}
          </ResponsiveContainer>
        </Card>
        <Card style={{ overflow: "hidden" }}>
          <div style={{ padding: "16px 20px", borderBottom: "1px solid #F3ECE3" }}>
            <div style={{ fontFamily: "'Fredoka', serif", fontWeight: 600, fontSize: 18 }}>Grant History</div>
          </div>
          <div style={{ maxHeight: 320, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#FFF8F2" }}>
                  {["Year", "Payment", "Amount"].map(h => (
                    <th key={h} style={{ padding: "10px 16px", textAlign: "left", fontFamily: "'Fredoka', serif", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "#7C8C8A" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rec.grants.slice().sort((a, b) => (b.year - a.year) || ((b.checkDate || "") < (a.checkDate || "") ? -1 : 1)).map((g, i) => (
                  <GrantHistoryRow key={(g.id || g.year) + "-" + i} g={g} i={i} signedIn={signedIn} />
                ))}
              </tbody>
            </table>
          </div>
          {signedIn && <div style={{ padding: "8px 16px", fontSize: 11.5, color: "#9B8E80", fontFamily: FONT_BODY }}>Click the &#9998; on any grant to record its check number and date.</div>}
        </Card>
      </div>

      {/* Programs & outcomes */}
      <div style={{ marginTop: 32 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8, marginBottom: 6 }}>
          <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 24, color: INK }}>Programs &amp; Outcomes</div>
          {signedIn && !editingProgram && <MiniButton kind="edit" onClick={() => setEditingProgram("new")}>+ Add a program</MiniButton>}
        </div>
        <div style={{ fontSize: 13, color: "#7C8C8A", fontFamily: FONT_BODY, marginBottom: 16, maxWidth: 720 }}>
          What this grantee&rsquo;s funding supports, and the outcomes we expect to see — tracked against target as results come in.
        </div>

        {signedIn && editingProgram && (
          <ProgramEditor org={org} program={editingProgram === "new" ? null : editingProgram} onDone={() => setEditingProgram(null)} />
        )}

        {programs.length === 0 && !editingProgram && (
          <Card style={{ padding: "28px 24px", textAlign: "center", color: "#9B8E80", fontFamily: FONT_BODY, fontSize: 14 }}>
            No programs tracked yet.{signedIn ? " Add one to set the outcomes we expect from this grantee." : ""}
          </Card>
        )}

        <div style={{ display: "grid", gridTemplateColumns: narrow ? "1fr" : "1fr 1fr", gap: 16 }}>
          {programs.map(p => (
            <ProgramCard key={p.id} program={p} color={c} signedIn={signedIn} narrow={narrow} onEdit={() => setEditingProgram(p)} />
          ))}
        </div>
      </div>

      {/* Updates feed */}
      <div style={{ marginTop: 32 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
          <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 24, color: INK }}>Updates</div>
          {signedIn && !composing && <MiniButton kind="edit" onClick={() => setComposing(true)}>+ Post an update</MiniButton>}
        </div>

        {signedIn && composing && <UpdateComposer org={org} onDone={() => setComposing(false)} />}

        {updates.length === 0 && !composing && (
          <Card style={{ padding: "28px 24px", textAlign: "center", color: "#9B8E80", fontFamily: FONT_BODY, fontSize: 14 }}>
            No updates yet.{signedIn ? " Post the first one — a note, photos, or a document." : ""}
          </Card>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {updates.map(u => (
            <Card key={u.id} style={{ padding: narrow ? "20px" : "24px 26px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                {u.title && <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 18, color: INK }}>{u.title}</div>}
                <div style={{ fontSize: 12, color: "#9B8E80", fontFamily: FONT_BODY }}>{fmtDate(u.created_at)}{u.author ? " · " + u.author : ""}</div>
              </div>
              {u.body && <div style={{ fontSize: 14.5, color: INK, lineHeight: 1.6, marginTop: u.title ? 8 : 0, fontFamily: FONT_BODY, whiteSpace: "pre-wrap" }}>{u.body}</div>}
              {u.photos && u.photos.length > 0 && (() => {
                const imgs = u.photos.filter(attIsImage);
                const docs = u.photos.filter(a => !attIsImage(a));
                return (
                  <>
                    {imgs.length > 0 && (
                      <div style={{ display: "grid", gridTemplateColumns: narrow ? "repeat(2,1fr)" : "repeat(auto-fill, minmax(150px, 1fr))", gap: 10, marginTop: 14 }}>
                        {imgs.map((a, i) => (
                          <a key={i} href={attUrl(a)} target="_blank" rel="noopener noreferrer" style={{ display: "block" }}>
                            <img src={attUrl(a)} alt="" loading="lazy" style={{ width: "100%", height: 140, objectFit: "cover", borderRadius: 12, border: "1px solid " + LINE, display: "block" }} />
                          </a>
                        ))}
                      </div>
                    )}
                    {docs.length > 0 && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
                        {docs.map((a, i) => (
                          <a key={i} href={attUrl(a)} target="_blank" rel="noopener noreferrer" style={{
                            display: "inline-flex", alignItems: "center", gap: 8, background: "#FBF4EC", border: "1px solid " + LINE,
                            borderRadius: 10, padding: "9px 13px", textDecoration: "none", color: INK, fontFamily: FONT_BODY, fontSize: 13.5, fontWeight: 600,
                          }}>
                            <span style={{ color: CORAL, fontWeight: 700 }}>📄</span>
                            <span style={{ maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{attName(a)}</span>
                          </a>
                        ))}
                      </div>
                    )}
                  </>
                );
              })()}
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
//  FORM PAGES  (Request a Grant · Make a Contribution)
// =============================================================================

function FormField({ label, children, hint }) {
  return (
    <label style={{ display: "block", marginBottom: 16 }}>
      <div style={{ fontFamily: FONT_BODY, fontWeight: 700, fontSize: 13, color: INK, marginBottom: 5 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 12, color: "#9B8E80", marginTop: 4 }}>{hint}</div>}
    </label>
  );
}

const formInput = {
  width: "100%", border: "1.5px solid " + LINE, borderRadius: 12, padding: "11px 14px",
  fontSize: 15, fontFamily: FONT_BODY, color: INK, background: "#fff", outline: "none",
};

function FormShell({ title, accent, lead, narrow, setView, children, done, doneMsg }) {
  return (
    <div style={{ maxWidth: 620, margin: "0 auto", padding: narrow ? "28px 16px 60px" : "44px 40px 80px" }}>
      <button onClick={() => setView("pulse")} style={{ background: "none", border: "none", color: TEAL, cursor: "pointer", fontSize: 13, fontWeight: 700, marginBottom: 18, fontFamily: FONT_BODY }}>&larr; Back to dashboard</button>
      <div style={{ background: "#fff", border: "1.5px solid " + LINE, borderRadius: 24, padding: narrow ? "28px 22px" : "40px 44px" }}>
        {done ? (
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}><HopMark size={58} /></div>
            <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 26, color: INK }}>Thank you!</div>
            <div style={{ fontFamily: FONT_BODY, fontSize: 15.5, color: "#6F7E7C", marginTop: 10, lineHeight: 1.6, maxWidth: 420, marginInline: "auto" }}>{doneMsg}</div>
            <button onClick={() => setView("pulse")} style={{ marginTop: 22, background: TEAL, color: "#fff", border: "none", borderRadius: 12, padding: "11px 22px", fontSize: 14, fontWeight: 700, fontFamily: FONT_BODY, cursor: "pointer" }}>Back to the dashboard</button>
          </div>
        ) : (
          <>
            <div style={{ fontFamily: FONT_ACCENT, fontWeight: 700, fontSize: 30, color: accent, lineHeight: 1, marginBottom: 2 }}>{lead}</div>
            <h1 style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: narrow ? 28 : 34, color: INK, lineHeight: 1.1, margin: "0 0 20px" }}>{title}</h1>
            {children}
          </>
        )}
      </div>
    </div>
  );
}

function RequestGrantForm({ narrow, setView }) {
  const { grants } = useData();
  const { session, setSession } = useAuth();
  const orgNames = useMemo(() => Array.from(new Set(grants.map(g => normalizeOrg(g.org)))).sort(), [grants]);
  const [org, setOrg] = useState("");
  const [requestedBy, setRequestedBy] = useState("");
  const [email, setEmail] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (!org.trim() || !requestedBy.trim()) { setErr("Please add the organization and your name."); return; }
    setBusy(true); setErr("");
    try {
      await authedWrite(session, setSession, "POST", "grant_requests", {
        org: org.trim(), requested_by: requestedBy.trim(),
        requester_email: email.trim() || null,
        amount: amount === "" ? null : Number(amount),
        category: category || null, notes: notes.trim() || null,
      });
      setDone(true);
    } catch (e2) { setErr(e2.message); setBusy(false); }
  }

  return (
    <FormShell narrow={narrow} setView={setView} accent={CORAL} lead="put one forward" title="Recommend a grant"
      done={done} doneMsg="Your recommendation is in. A trustee will review it for the next giving cycle.">
      <p style={{ fontFamily: FONT_BODY, fontSize: 15, color: "#6F7E7C", lineHeight: 1.6, marginBottom: 22 }}>
        Know an organization Kendacar should support? Put it forward here and a trustee will take a look.
      </p>
      <form onSubmit={submit}>
        <FormField label="Organization" hint="Start typing — past grantees will suggest themselves.">
          <input list="org-options" value={org} onChange={e => setOrg(e.target.value)} placeholder="Organization name" style={formInput} />
          <datalist id="org-options">{orgNames.map(o => <option key={o} value={o} />)}</datalist>
        </FormField>
        <div style={{ display: "grid", gridTemplateColumns: narrow ? "1fr" : "1fr 1fr", gap: 14 }}>
          <FormField label="Your name">
            <input value={requestedBy} onChange={e => setRequestedBy(e.target.value)} placeholder="Who's recommending this" style={formInput} />
          </FormField>
          <FormField label="Your email" hint="So we can let you know when it's sent.">
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@email.com" style={formInput} />
          </FormField>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: narrow ? "1fr" : "1fr 1fr", gap: 14 }}>
          <FormField label="Suggested amount" hint="Optional">
            <input type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="$" style={formInput} />
          </FormField>
          <FormField label="Focus area" hint="Optional">
            <select value={category} onChange={e => setCategory(e.target.value)} style={{ ...formInput, cursor: "pointer" }}>
              <option value="">Choose one…</option>
              {CATEGORY_LIST.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </FormField>
        </div>
        <FormField label="Why this organization?" hint="Optional — a sentence or two helps.">
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={4} placeholder="What they do and why it matters" style={{ ...formInput, resize: "vertical" }} />
        </FormField>
        {err && <div style={{ color: "#B5451B", fontSize: 13, marginBottom: 12 }}>{err}</div>}
        <button type="submit" disabled={busy} style={{ background: CORAL, color: "#fff", border: "none", borderRadius: 12, padding: "13px 26px", fontSize: 15, fontWeight: 700, fontFamily: FONT_BODY, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}>
          {busy ? "Sending…" : "Submit recommendation"}
        </button>
      </form>
    </FormShell>
  );
}

function ContributionForm({ narrow, setView }) {
  const { signedIn, session, setSession } = useAuth();
  const { refresh } = useData();
  const [donor, setDonor] = useState("");
  const [giftDate, setGiftDate] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState("");
  const [giftType, setGiftType] = useState("cash");
  const [rows, setRows] = useState([{ symbol: "", quantity: "", market_value: "" }]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);

  const secRows = rows.filter(r => r.symbol.trim() && r.market_value !== "");
  const secTotal = secRows.reduce((t, r) => t + (Number(r.market_value) || 0), 0);
  const isSec = giftType === "securities";
  // A securities gift is worth the sum of its holdings; cash is whatever was typed.
  const finalAmount = isSec && secRows.length ? secTotal : Number(amount);
  const setRow = (i, k, v) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));

  async function submit(e) {
    e.preventDefault();
    if (!donor.trim()) { setErr("Please add the donor's name."); return; }
    if (!finalAmount || isNaN(finalAmount)) { setErr(isSec ? "Add at least one holding with a market value." : "Please add a numeric amount."); return; }
    setBusy(true); setErr("");
    try {
      if (signedIn) {
        // Trustees write straight to the gift detail, so it shows on the Contributions page at once.
        await authedWrite(session, setSession, "POST", "contribution_gifts", {
          gift_date: giftDate, donor: donor.trim(), amount: finalAmount, gift_type: giftType,
          securities: isSec ? secRows.map(r => ({ symbol: r.symbol.trim().toUpperCase(), quantity: Number(r.quantity) || null, market_value: Number(r.market_value) || 0 })) : [],
          note: note.trim() || null,
        });
        await refresh();
      } else {
        // Anyone else lands in the inbox, which emails a trustee to record it.
        await authedWrite(session, setSession, "POST", "contributions", {
          donor: donor.trim(), amount: finalAmount,
          note: [note.trim(), "Gift date: " + giftDate, isSec ? "Securities: " + secRows.map(r => r.quantity + " " + r.symbol).join(", ") : "Cash"].filter(Boolean).join("\n"),
        });
      }
      setDone(true);
    } catch (e2) { setErr(e2.message); setBusy(false); }
  }

  return (
    <FormShell narrow={narrow} setView={setView} accent={SOFT_TEAL} lead="give in" title="Record a contribution"
      done={done} doneMsg="Thank you for giving into the fund. Your contribution has been recorded.">
      <p style={{ fontFamily: FONT_BODY, fontSize: 15, color: "#6F7E7C", lineHeight: 1.6, marginBottom: 22 }}>
        Adding to the Kendacar fund? Record it here so it shows up in the foundation's contribution history.
      </p>
      <form onSubmit={submit}>
        <FormField label="Your name">
          <input value={donor} onChange={e => setDonor(e.target.value)} placeholder="Donor name" style={formInput} />
        </FormField>
        <FormField label="Date of the gift">
          <input type="date" value={giftDate} onChange={e => setGiftDate(e.target.value)} style={formInput} />
        </FormField>
        <FormField label="What was given">
          <div style={{ display: "flex", gap: 8 }}>
            {[["cash", "Cash"], ["securities", "Stock or securities"]].map(([id, lbl]) => (
              <button type="button" key={id} onClick={() => setGiftType(id)} style={{
                flex: 1, background: giftType === id ? TEAL : "#fff", color: giftType === id ? "#fff" : "#7C8C8A",
                border: "1px solid " + (giftType === id ? TEAL : "#E2D7C9"), borderRadius: 10,
                padding: "11px 14px", fontSize: 14, fontWeight: 700, fontFamily: FONT_BODY, cursor: "pointer",
              }}>{lbl}</button>
            ))}
          </div>
        </FormField>
        {isSec ? (
          <FormField label="Holdings" hint="One line per security">
            {rows.map((r, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1.2fr auto", gap: 8, marginBottom: 8 }}>
                <input value={r.symbol} onChange={e => setRow(i, "symbol", e.target.value)} placeholder="Symbol" style={formInput} />
                <input type="number" value={r.quantity} onChange={e => setRow(i, "quantity", e.target.value)} placeholder="Shares" style={formInput} />
                <input type="number" value={r.market_value} onChange={e => setRow(i, "market_value", e.target.value)} placeholder="Market value $" style={formInput} />
                <button type="button" onClick={() => setRows(rows.length > 1 ? rows.filter((_, j) => j !== i) : rows)}
                  title="Remove" style={{ background: "none", border: "1px solid #E2D7C9", borderRadius: 8, padding: "0 12px", color: "#B5451B", cursor: "pointer", fontSize: 16 }}>&times;</button>
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <button type="button" onClick={() => setRows([...rows, { symbol: "", quantity: "", market_value: "" }])}
                style={{ background: "none", border: "none", color: TEAL, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: FONT_BODY, padding: 0 }}>+ Add another security</button>
              {secRows.length > 0 && <div style={{ fontSize: 13.5, color: INK, fontFamily: FONT_BODY }}>Total market value <strong style={{ color: TEAL }}>{fmt(secTotal)}</strong></div>}
            </div>
          </FormField>
        ) : (
          <FormField label="Amount">
            <input type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="$" style={formInput} />
          </FormField>
        )}
        <FormField label="Note" hint="Optional">
          <textarea value={note} onChange={e => setNote(e.target.value)} rows={3} placeholder="Anything to add" style={{ ...formInput, resize: "vertical" }} />
        </FormField>
        {err && <div style={{ color: "#B5451B", fontSize: 13, marginBottom: 12 }}>{err}</div>}
        <button type="submit" disabled={busy} style={{ background: TEAL, color: "#fff", border: "none", borderRadius: 12, padding: "13px 26px", fontSize: 15, fontWeight: 700, fontFamily: FONT_BODY, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}>
          {busy ? "Recording…" : "Record contribution"}
        </button>
      </form>
    </FormShell>
  );
}

// =============================================================================
//  PROCESSING QUEUE  (signed-in trustees — recommendations to process)
// =============================================================================

function MarkSentRow({ req, onDone }) {
  const { session, setSession } = useAuth();
  const { refresh, granteeNotes, granteeDocs } = useData();
  // Nothing here blocks a check; it just says plainly what isn't on file yet.
  const fileKey = [normalizeOrg(req.org), req.org].find(k => (granteeNotes || {})[k]);
  const fileNote = fileKey ? granteeNotes[fileKey] : null;
  const fileGaps = !fileNote
    ? ["no grantee file yet (legal name, EIN and IRS status aren't recorded)"]
    : diligenceFor(fileNote, (granteeDocs || {})[fileKey]).missing.map(i => i.label + (i.ideal ? " (ideal to have)" : ""));
  const today = new Date().toISOString().slice(0, 10);
  const [amount, setAmount] = useState(req.amount != null ? req.amount : "");
  const [date, setDate] = useState(today);
  const [checkNo, setCheckNo] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function markSent() {
    if (amount === "" || isNaN(Number(amount))) { setErr("Enter the amount that was sent."); return; }
    setBusy(true); setErr("");
    const yr = date ? Number(date.slice(0, 4)) : new Date().getFullYear();
    try {
      // 1) create the grant (carrying the check details)
      await authedWrite(session, setSession, "POST", "grants",
        { year: yr, org: req.org, amount: Number(amount), category: req.category || "Community & Social Services",
          check_number: checkNo.trim() || null, check_date: date || null });
      // 2) mark the recommendation as sent, linked to the grant just created
      let grantId = null;
      try {
        const made = await authedGet(session, setSession, "grants?select=id&org=eq." + encodeURIComponent(req.org) + "&order=id.desc&limit=1");
        grantId = made && made[0] ? made[0].id : null;
      } catch { /* the link is a nicety; the sent status still saves */ }
      await authedWrite(session, setSession, "PATCH", "grant_requests?id=eq." + req.id,
        { status: "sent", check_date: date || null, check_number: checkNo.trim() || null, processed_at: new Date().toISOString(),
          ...(grantId ? { grant_id: grantId } : {}) });
      // 3) open a personal confirmation email in your mail app (if we have their address)
      if (req.requester_email) {
        const subject = "Your Kendacar grant to " + req.org + " is on its way";
        const body =
          "Hi " + (req.requested_by || "there") + ",\n\n" +
          "Great news — the grant you recommended for " + req.org + " (" + fmt(Number(amount)) + ") has been approved and sent.\n\n" +
          "Thank you for putting it forward.\n\n" +
          "— Kendacar Foundation";
        const a = document.createElement("a");
        a.href = "mailto:" + encodeURIComponent(req.requester_email) + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
        a.click();
      }
      await refresh(); onDone();
    } catch (e) { setErr(e.message); setBusy(false); }
  }

  return (
    <div style={{ marginTop: 12, paddingTop: 14, borderTop: "1px dashed " + LINE }}>
      {fileGaps.length > 0 && (
        <div style={{ background: "#FFF6E5", border: "1px solid #F4C95D", borderRadius: 10, padding: "10px 14px", marginBottom: 12, fontSize: 13, color: "#7A5B12", fontFamily: FONT_BODY, lineHeight: 1.5 }}>
          <strong>Not on file for {req.org}:</strong> {fileGaps.join(" · ")}. You can still post the grant and add these on the grantee's page later.
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: narrow720() ? "1fr" : "1fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
        <div><label style={{ fontSize: 11, color: "#7C8C8A", fontWeight: 700, display: "block", marginBottom: 3 }}>Amount sent ($)</label><EdInput type="number" value={amount} onChange={setAmount} /></div>
        <div><label style={{ fontSize: 11, color: "#7C8C8A", fontWeight: 700, display: "block", marginBottom: 3 }}>Date sent</label><EdInput type="date" value={date} onChange={setDate} /></div>
        <div><label style={{ fontSize: 11, color: "#7C8C8A", fontWeight: 700, display: "block", marginBottom: 3 }}>Check # (optional)</label><EdInput value={checkNo} onChange={setCheckNo} /></div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <MiniButton kind="save" onClick={markSent} disabled={busy}>{busy ? "Posting…" : (req.requester_email ? "Confirm — post grant & draft email" : "Confirm — post grant")}</MiniButton>
        <MiniButton kind="cancel" onClick={onDone} disabled={busy}>Cancel</MiniButton>
      </div>
      {req.requester_email && <div style={{ fontSize: 11.5, color: "#9B8E80", marginTop: 8 }}>Opens a pre-written note to {req.requester_email} in your mail app to review &amp; send.</div>}
      {err && <div style={{ color: "#B5451B", fontSize: 12, marginTop: 8 }}>{err}</div>}
    </div>
  );
}

function ProcessingQueue({ narrow, setView, onChange }) {
  const { session, setSession } = useAuth();
  const [items, setItems] = useState(null);
  const [err, setErr] = useState("");
  const [openId, setOpenId] = useState(null);
  const [tab, setTab] = useState("new");

  async function load() {
    try {
      // Pull every submission, not just the waiting ones — the processed history lives here too.
      setItems(await authedGet(session, setSession, "grant_requests?order=created_at.desc&select=id,org,amount,requested_by,requester_email,category,notes,created_at,status,check_number,check_date,processed_at"));
      onChange && onChange();
    } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  async function dismiss(id) {
    if (!window.confirm("Dismiss this recommendation? It won't be processed.")) return;
    try { await authedWrite(session, setSession, "PATCH", "grant_requests?id=eq." + id, { status: "declined", processed_at: new Date().toISOString() }); load(); }
    catch (e) { setErr(e.message); }
  }
  const after = () => { setOpenId(null); load(); };

  const all = items || [];
  const counts = { new: 0, sent: 0, declined: 0 };
  all.forEach(r => { if (counts[r.status] != null) counts[r.status]++; });
  const TABS = [
    { id: "new",      label: "Waiting" },
    { id: "sent",     label: "Sent" },
    { id: "declined", label: "Declined" },
  ];
  const shown = all.filter(r => r.status === tab);
  const EMPTY = {
    new: "Nothing waiting — you're all caught up. 🎉",
    sent: "No submissions have been processed yet.",
    declined: "Nothing has been declined.",
  };

  return (
    <div style={{ maxWidth: 880, margin: "0 auto", padding: narrow ? "28px 16px" : "36px 40px" }}>
      <button onClick={() => setView("pulse")} style={{ background: "none", border: "none", color: TEAL, cursor: "pointer", fontSize: 13, fontWeight: 700, marginBottom: 16, fontFamily: FONT_BODY }}>&larr; Back to dashboard</button>
      <SectionTitle title="Grant recommendations" sub="Family submissions and what happened to each one. Confirm one and it posts to the dashboard automatically." />

      {err && <div style={{ color: "#B5451B", fontSize: 13, marginBottom: 12 }}>{err}</div>}
      {items === null && !err && <div style={{ color: "#7C8C8A", fontFamily: FONT_BODY }}>Loading…</div>}

      {/* Status tabs — the processed history is here, not just what's waiting. */}
      <div style={{ display: "flex", gap: 2, marginBottom: 20, borderBottom: "2px solid #EFE7DD" }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            background: "none", border: "none", borderBottom: tab === t.id ? "2px solid " + TEAL : "2px solid transparent",
            marginBottom: -2, padding: "10px 18px", fontSize: 13, fontFamily: FONT_BODY,
            fontWeight: tab === t.id ? 600 : 400, color: tab === t.id ? TEAL : "#7C8C8A", cursor: "pointer",
          }}>{t.label} ({counts[t.id]})</button>
        ))}
      </div>

      {items && shown.length === 0 && (
        <Card style={{ padding: "30px 24px", textAlign: "center", color: "#9B8E80", fontFamily: FONT_BODY }}>{EMPTY[tab]}</Card>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {shown.map(r => (
          <Card key={r.id} style={{ padding: narrow ? "18px" : "20px 24px", borderLeft: "4px solid " + (r.status === "sent" ? "#1F9E6E" : r.status === "declined" ? "#C8BBA8" : CORAL) }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 18, color: INK }}>{r.org}</div>
                <div style={{ fontSize: 13, color: "#7C8C8A", fontFamily: FONT_BODY, marginTop: 3 }}>
                  Recommended by {r.requested_by}{r.requester_email ? " · " + r.requester_email : ""} · {fmtDate(r.created_at)}
                </div>
                {r.category && <span style={{ display: "inline-block", marginTop: 8, background: (CAT_COLORS[r.category] || "#999") + "18", color: CAT_COLORS[r.category] || "#999", borderRadius: 20, padding: "2px 10px", fontSize: 11, fontWeight: 700 }}>{r.category}</span>}
                {r.notes && <div style={{ fontSize: 13.5, color: INK, fontFamily: FONT_BODY, lineHeight: 1.55, marginTop: 10, maxWidth: 560 }}>{r.notes}</div>}
              </div>
              <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                <div style={{ fontSize: 11, color: "#7C8C8A", fontWeight: 700, fontFamily: FONT_BODY }}>{r.status === "sent" ? "SENT" : "SUGGESTED"}</div>
                <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 24, color: TEAL }}>{r.amount != null ? fmt(r.amount) : "—"}</div>
              </div>
            </div>
            {r.status === "new" && (openId === r.id ? (
              <MarkSentRow req={r} onDone={after} />
            ) : (
              <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                <MiniButton kind="save" onClick={() => setOpenId(r.id)}>Mark sent →</MiniButton>
                <MiniButton kind="delete" onClick={() => dismiss(r.id)}>Dismiss</MiniButton>
              </div>
            ))}
            {r.status === "sent" && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px dashed " + LINE, fontSize: 12.5, color: "#5E6E6C", fontFamily: FONT_BODY }}>
                Sent{r.check_date ? " " + fmtCheckDate(r.check_date) : ""}
                {r.check_number ? " · check #" + r.check_number : ""}
                {r.processed_at ? " · recorded " + fmtDate(r.processed_at) : ""}
              </div>
            )}
            {r.status === "declined" && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px dashed " + LINE, fontSize: 12.5, color: "#9B8E80", fontFamily: FONT_BODY }}>
                Declined{r.processed_at ? " " + fmtDate(r.processed_at) : ""} — not processed.
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}

// =============================================================================
//  MAIN APP
// =============================================================================

// =============================================================================
//  ACCESS  (family only): who can sign in to Kendacar
// =============================================================================

const ACCESS_ROLES = { admin: "Family · can view and edit", advisor: "Advisor · view only" };
const ACCESS_ERRORS = {
  not_allowed: "Only family members can change access.",
  invalid_email: "That doesn't look like an email address.",
  cannot_remove_self: "You can't remove yourself.",
  cannot_demote_self: "You can't change yourself to view only.",
};
const accessError = e => {
  const k = Object.keys(ACCESS_ERRORS).find(key => String(e && e.message).includes(key));
  return k ? ACCESS_ERRORS[k] : (e && e.message) || "Something went wrong.";
};
const inviteMailto = (addr, role) => {
  const subject = "Your Kendacar Foundation sign-in";
  const body =
    "Hi,\n\nYou now have " + (role === "advisor" ? "view-only " : "") + "access to the Kendacar Foundation site.\n\n" +
    "1. Go to https://kendacar.org and choose Sign in, then \"Create your password\".\n" +
    "2. Use this email address: " + addr + "\n" +
    "3. We'll email you a confirmation link. Click it and you're in.\n\n" +
    "After that, just sign in with your email and password. If you ever forget it, use \"Forgot password\".\n\n" +
    "— Kendacar Foundation";
  return "mailto:" + encodeURIComponent(addr) + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
};

function AccessView({ narrow }) {
  const { session, setSession, email: me } = useAuth();
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [addr, setAddr] = useState("");
  const [role, setRole] = useState("admin");
  const [justAdded, setJustAdded] = useState(null);

  async function load() {
    try { setRows(await authedGet(session, setSession, "rpc/kendacar_access_list")); }
    catch (e) { setErr(accessError(e)); setRows([]); }
  }
  useEffect(() => { load(); }, []);

  async function add(e) {
    e.preventDefault();
    const clean = addr.trim().toLowerCase();
    if (!clean) return;
    setBusy("add"); setErr("");
    try {
      await authedWrite(session, setSession, "POST", "rpc/kendacar_access_set", { p_email: clean, p_role: role });
      setJustAdded({ email: clean, role }); setAddr(""); await load();
    } catch (e2) { setErr(accessError(e2)); }
    finally { setBusy(""); }
  }
  async function changeRole(r, next) {
    setBusy(r.email); setErr("");
    try { await authedWrite(session, setSession, "POST", "rpc/kendacar_access_set", { p_email: r.email, p_role: next }); await load(); }
    catch (e) { setErr(accessError(e)); }
    finally { setBusy(""); }
  }
  async function remove(r) {
    if (!window.confirm("Remove " + r.email + "? They won't be able to sign in to Kendacar anymore.")) return;
    setBusy(r.email); setErr("");
    try { await authedWrite(session, setSession, "POST", "rpc/kendacar_access_remove", { p_email: r.email }); await load(); }
    catch (e) { setErr(accessError(e)); }
    finally { setBusy(""); }
  }

  const status = r => r.last_sign_in
    ? { text: "Signed in " + fmtDate(r.last_sign_in), color: "#0E7A5F", bg: "#EAF7F2" }
    : r.confirmed ? { text: "Password set", color: "#0E7A5F", bg: "#EAF7F2" }
    : r.has_account ? { text: "Waiting on their confirmation email", color: "#9A7B1E", bg: "#FFF6E5" }
    : { text: "Hasn't created a password yet", color: "#7C8C8A", bg: "#F3ECE3" };
  const isMe = r => (r.email || "").toLowerCase() === (me || "").toLowerCase();
  const families = (rows || []).filter(r => r.role === "admin").length;

  return (
    <div style={{ maxWidth: 1140, margin: "0 auto", padding: narrow ? "28px 16px" : "36px 40px" }}>
      <SectionTitle title="Access" sub="Who can sign in to Kendacar. Only people on this list can create a password." />

      <Card style={{ padding: narrow ? 20 : 26, marginBottom: 24, background: "#FBF4EC" }}>
        <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 18, marginBottom: 12 }}>Add someone</div>
        <form onSubmit={add} style={{ display: "grid", gridTemplateColumns: narrow ? "1fr" : "minmax(0,1.4fr) minmax(0,1fr) auto", gap: 10, alignItems: "center" }}>
          <input type="email" value={addr} onChange={e => setAddr(e.target.value)} placeholder="name@email.com" style={{ ...formInput, fontSize: 14.5, padding: "11px 14px" }} />
          <select value={role} onChange={e => setRole(e.target.value)} style={{ ...formInput, fontSize: 14.5, padding: "11px 14px" }}>
            <option value="admin">{ACCESS_ROLES.admin}</option>
            <option value="advisor">{ACCESS_ROLES.advisor}</option>
          </select>
          <button type="submit" disabled={busy === "add" || !addr.trim()} style={{ background: TEAL, color: "#fff", border: "none", borderRadius: 10, padding: "11px 22px", fontSize: 14.5, fontWeight: 700, fontFamily: FONT_BODY, cursor: "pointer", opacity: busy === "add" || !addr.trim() ? 0.6 : 1 }}>
            {busy === "add" ? "Adding…" : "Add"}
          </button>
        </form>
        {justAdded && (
          <div style={{ marginTop: 14, background: "#EAF7F2", border: "1px solid #BFE0DE", borderRadius: 10, padding: "12px 14px", fontSize: 13.5, color: "#1F3A38", fontFamily: FONT_BODY, lineHeight: 1.55 }}>
            <strong>{justAdded.email}</strong> is on the list. Let them know to go to kendacar.org and choose <em>Create your password</em>.{" "}
            <a href={inviteMailto(justAdded.email, justAdded.role)} style={{ color: TEAL, fontWeight: 800 }}>Write them an email →</a>
          </div>
        )}
        {err && <div style={{ color: "#B5451B", fontSize: 13, marginTop: 10, fontFamily: FONT_BODY }}>{err}</div>}
      </Card>

      <Card style={{ padding: narrow ? "8px 16px" : "8px 26px" }}>
        {rows === null && <div style={{ padding: 24, color: "#7C8C8A", fontFamily: FONT_BODY }}>Loading…</div>}
        {rows && rows.length === 0 && !err && <div style={{ padding: 24, color: "#7C8C8A", fontFamily: FONT_BODY }}>No one is on the list.</div>}
        {(rows || []).map((r, i) => {
          const st = status(r);
          const locked = isMe(r);
          return (
            <div key={r.email} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", padding: "14px 0", borderTop: i ? "1px solid #F3ECE3" : "none" }}>
              <div style={{ minWidth: 0, flex: "1 1 260px" }}>
                <div style={{ fontSize: 14.5, fontWeight: 700, color: INK, fontFamily: FONT_BODY, overflowWrap: "anywhere" }}>
                  {r.email}{locked && <span style={{ color: "#9B8E80", fontWeight: 600 }}> (you)</span>}
                </div>
                <span style={{ display: "inline-block", marginTop: 5, fontSize: 11.5, fontWeight: 800, color: st.color, background: st.bg, borderRadius: 20, padding: "2px 10px", fontFamily: FONT_BODY }}>{st.text}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <select value={r.role} disabled={locked || busy === r.email} onChange={e => changeRole(r, e.target.value)} title={locked ? "You can't change your own access" : "Change access"}
                  style={{ ...formInput, width: "auto", fontSize: 13.5, padding: "8px 12px", opacity: locked ? 0.6 : 1 }}>
                  <option value="admin">{ACCESS_ROLES.admin}</option>
                  <option value="advisor">{ACCESS_ROLES.advisor}</option>
                </select>
                {!r.confirmed && <a href={inviteMailto(r.email, r.role)} style={{ color: TEAL, fontSize: 13, fontWeight: 700, textDecoration: "none", fontFamily: FONT_BODY }}>Email invite</a>}
                {!locked && <button onClick={() => remove(r)} disabled={busy === r.email} style={subAction(true)}>Remove</button>}
              </div>
            </div>
          );
        })}
      </Card>
      {rows && rows.length > 0 && (
        <div style={{ fontSize: 12.5, color: "#7C8C8A", marginTop: 12, fontFamily: FONT_BODY }}>
          {families} family · {rows.length - families} advisor{rows.length - families === 1 ? "" : "s"}. Removing someone stops them signing in; you can add them back anytime.
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [view, setView] = useState("pulse");
  const [selectedOrg, setSelectedOrg] = useState(null);
  const [data, setData] = useState(EMPTY_DATA);
  const [loaded, setLoaded] = useState(false);
  const [session, setSession] = useState(null);
  const [role, setRole] = useState(null);           // null = checking, "admin", "advisor", "none", "error"
  const [restoring, setRestoring] = useState(true); // true until any saved sign-in has been checked
  const [attempt, setAttempt] = useState(0);
  const [resetting, setResetting] = useState(false); // arrived from a "reset password" email
  const [pending, setPending] = useState(0);        // count of new submissions
  const width = useWindowWidth();
  const narrow = width < 720;

  // Loaders run later from child components, so they read the latest session through a ref.
  const sessionRef = useRef(null);
  sessionRef.current = session;
  const get = path => authedGet(sessionRef.current, setSession, path);

  const refreshPending = async () => {
    if (!sessionRef.current) { setPending(0); return; }
    try { const rows = await get("grant_requests?status=eq.new&select=id"); setPending(rows.length); }
    catch { /* ignore */ }
  };

  const loadData = async () => {
    if (!sessionRef.current) return null;
    try { const live = await fetchLiveData(get); setData(live); setLoaded(true); return live; }
    catch { setLoaded(true); return null; }
  };

  // On load: capture a sign-in from the email link, or restore a saved one.
  useEffect(() => {
    const fromHash = sessionFromHash();
    const saved = fromHash || loadSession();
    if (fromHash) { saveSession(fromHash); if (fromHash.type === "recovery") setResetting(true); }
    const h = window.location.hash.replace("#", "");
    if (h === "request-grant" || h === "contribute") setView(h);
    else if (h === "review" || h === "queue") setView("queue");
    if (!saved) { setRestoring(false); return; }
    if (saved.expires_at && saved.expires_at < Date.now()) {
      refreshSession(saved).then(r => {
        if (r) { saveSession(r); setSession(r); } else saveSession(null);
        setRestoring(false);
      });
    } else { setSession(saved); setRestoring(false); }
  }, []);

  // When someone signs in, ask the database what they may do, then load what they may see.
  const who = session ? session.email : "";
  useEffect(() => {
    if (!who) { setRole(null); setData(EMPTY_DATA); setLoaded(false); setPending(0); return; }
    let alive = true;
    setRole(null);
    (async () => {
      try {
        const [member, admin] = await Promise.all([get("rpc/is_member"), get("rpc/is_admin")]);
        if (!alive) return;
        const r = admin === true ? "admin" : member === true ? "advisor" : "none";
        setRole(r);
        if (r !== "none") { loadData(); if (r === "admin") refreshPending(); }
      } catch { if (alive) setRole("error"); }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line
  }, [who, attempt]);

  function nav(v) {
    setView(v); setSelectedOrg(null);
    const hashFor = (v === "request-grant" || v === "contribute") ? v : (v === "queue" ? "review" : "");
    history.replaceState(null, "", window.location.pathname + window.location.search + (hashFor ? "#" + hashFor : ""));
    window.scrollTo({ top: 0 });
  }
  function goGrantee(org) { setSelectedOrg(org); setView("grantee-detail"); window.scrollTo({ top: 0 }); }
  const signOut = () => { saveSession(null); setSession(null); setView("pulse"); };

  const auth = {
    session, setSession,
    member: role === "admin" || role === "advisor", // may see everything
    signedIn: role === "admin",                      // may edit: the flag every edit control checks
    advisor: role === "advisor",
    email: session?.email || "",
    signIn: async (addr, pw) => { const s = await signInWithPassword(addr, pw); saveSession(s); setSession(s); },
    createPassword: async (addr, pw) => { const s = await createPasswordFor(addr, pw); if (s) { saveSession(s); setSession(s); } return s; },
    sendPasswordReset,
    savePassword: async pw => { await updatePassword(sessionRef.current, pw); setResetting(false); },
    signOut,
  };
  const shell = inner => (
    <AuthContext.Provider value={auth}>
      <DataContext.Provider value={{ ...data, refresh: loadData, live: loaded }}>{inner}</DataContext.Provider>
    </AuthContext.Provider>
  );
  const pill = { background: TEAL, color: "#fff", border: "none", borderRadius: 10, padding: "10px 18px", fontSize: 14, fontWeight: 700, fontFamily: FONT_BODY, cursor: "pointer" };
  const pillQuiet = { ...pill, background: "#fff", color: TEAL, border: "1.5px solid " + TEAL };

  if (restoring || (session && role === null)) return shell(<NoticeScreen title="Signing you in…" />);
  if (!session) return shell(<WelcomePage narrow={narrow} />);
  if (resetting) return shell(<SetPasswordScreen />);
  if (role === "none") return shell(
    <NoticeScreen title="This email isn't on the Kendacar list" body={"You're signed in as " + auth.email + ", but that address hasn't been given access."}>
      <button style={pillQuiet} onClick={signOut}>Sign out</button>
    </NoticeScreen>);
  if (role === "error") return shell(
    <NoticeScreen title="Couldn't reach the foundation's records" body="Check your connection and try again.">
      <button style={pill} onClick={() => setAttempt(n => n + 1)}>Try again</button>
      <button style={pillQuiet} onClick={signOut}>Sign out</button>
    </NoticeScreen>);

  const isAdmin = auth.signedIn;
  // Submitting and processing are family actions; advisors land on the dashboard instead.
  const current = !isAdmin && ["queue", "request-grant", "contribute", "access"].includes(view) ? "pulse" : view;
  const barLink = { background: "none", border: "none", color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 700, textDecoration: "underline" };

  return shell(
    <div style={{ minHeight: "100vh", background: "#FFF8F2", fontFamily: "'Nunito Sans', sans-serif", color: "#1F3A38" }}>
      <NavBar view={current} setView={nav} narrow={narrow} signedIn={isAdmin} pending={pending} />
      <div style={{ background: isAdmin ? "#0E7A5F" : "#3A6B9C", color: "#fff", textAlign: "center", fontSize: 12, padding: "7px 16px", fontFamily: "'Nunito Sans', sans-serif" }}>
        {isAdmin ? "Edit mode" : "Read-only access"} — signed in as {auth.email} ·{" "}
        {isAdmin && <>
          <button onClick={() => nav("queue")} style={barLink}>Review submissions</button>
          {pending > 0 && <span style={{ background: CORAL, color: "#fff", borderRadius: 20, padding: "1px 8px", fontSize: 11, fontWeight: 800, marginLeft: 6 }}>{pending}</span>} ·{" "}
          <button onClick={() => nav("access")} style={barLink}>Access</button> ·{" "}
        </>}
        <button onClick={signOut} style={{ ...barLink, color: "#CFEFE5", fontWeight: 600 }}>Sign out</button>
      </div>

      {!loaded
        ? <div style={{ padding: "80px 20px", textAlign: "center", color: "#7C8C8A", fontFamily: FONT_BODY }}>Loading the foundation's records…</div>
        : <>
            {current === "pulse"          && <PulseLanding setView={nav} goGrantee={goGrantee} narrow={narrow} />}
            {current === "investments"    && <InvestmentsView narrow={narrow} />}
            {current === "grants"         && <GrantsView narrow={narrow} />}
            {current === "contributions"  && <ContributionsView narrow={narrow} />}
            {current === "grantees"       && <GranteesDirectory goGrantee={goGrantee} narrow={narrow} />}
            {current === "grantee-detail" && <GranteeDetail org={selectedOrg} setView={nav} goGrantee={goGrantee} narrow={narrow} />}
            {current === "request-grant"  && <RequestGrantForm narrow={narrow} setView={nav} />}
            {current === "contribute"     && <ContributionForm narrow={narrow} setView={nav} />}
            {current === "queue"          && <ProcessingQueue narrow={narrow} setView={nav} onChange={refreshPending} />}
            {current === "access"         && <AccessView narrow={narrow} />}
          </>}

      <div style={{ padding: "32px 20px", textAlign: "center", fontSize: 11, color: "#7C8C8A", fontFamily: "'Fredoka', serif", letterSpacing: "0.08em" }}>
        KENDACAR FOUNDATION &middot; CONFIDENTIAL &middot; FOR FAMILY USE ONLY
      </div>
    </div>
  );
}

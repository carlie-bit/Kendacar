import { useState, useMemo, useEffect, createContext, useContext } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, LineChart, Line, CartesianGrid, Area, AreaChart
} from "recharts";

// =============================================================================
//  SUPABASE — live data source + sign-in + editing
//  The dashboard reads these tables on load. When an approved person signs in
//  (magic link to their email), grant/donation/investment entries become
//  editable right on the page and changes write straight back here — no rebuild,
//  no git push. If Supabase is unreachable, the FALLBACK data keeps the site up.
// =============================================================================

const SUPABASE_URL = "https://kdmtjvbgeqcjipdnfwty.supabase.co";
const SUPABASE_KEY = "sb_publishable_tWKd0z8dbr2cAfExI11pPw_7ACCfjqa";
const REST = SUPABASE_URL + "/rest/v1/";
const AUTH = SUPABASE_URL + "/auth/v1/";
const SESSION_KEY = "kendacar_session";

// ---- read (uses the public key) ----
async function sb(path) {
  const res = await fetch(REST + path, {
    headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY },
  });
  if (!res.ok) throw new Error("Supabase " + res.status);
  return res.json();
}

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
  };
}

// Send a one-time sign-in link to an email. GoTrue reads the return URL from
// the `redirect_to` query parameter, so it must go on the URL (not the body).
async function sendMagicLink(email) {
  const redirect = window.location.origin + window.location.pathname;
  const res = await fetch(AUTH + "otp?redirect_to=" + encodeURIComponent(redirect), {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, create_user: true }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).msg || "Could not send link (" + res.status + ")");
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

// A public form submission (anyone may insert into the form tables).
async function publicInsert(table, payload) {
  const res = await fetch(REST + table, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("Submission failed (" + res.status + "). " + (await res.text().catch(() => "")));
  return true;
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
async function fetchLiveData() {
  const [grants, donations, assets, settings, notes, updates, programs] = await Promise.all([
    sb("grants?select=id,year,org,amount,category&order=year.desc,amount.desc"),
    sb("donations?select=id,year,donor,amount&order=year.desc"),
    sb("investment_assets?select=id,name,value,sort_order&order=sort_order"),
    sb("settings?select=key,value"),
    sb("grantee_notes?select=org,display_name,contact,contact_role,contact_email,website,description,community,note"),
    sb("grantee_updates?select=id,org,title,body,author,photos,created_at&order=created_at.desc"),
    sb("grantee_programs?select=id,org,name,purpose,metrics,sort_order,status&order=sort_order"),
  ]);
  const setMap = Object.fromEntries(settings.map(s => [s.key, s.value]));
  const noteMap = {};
  notes.forEach(n => { noteMap[n.org] = {
    displayName: n.display_name, contact: n.contact, contactRole: n.contact_role,
    contactEmail: n.contact_email, website: n.website, description: n.description,
    community: n.community, note: n.note,
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
  return {
    grants: grants.map(g => ({
      id: g.id, year: Number(g.year), org: g.org, amount: Number(g.amount),
      category: g.category || ORG_CATEGORIES[g.org] || "Community & Social Services",
    })),
    donations: donations.map(d => ({ id: d.id, year: Number(d.year), donor: d.donor, amount: Number(d.amount) })),
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
  };
}

// =============================================================================
//  FALLBACK GRANT DATA - Kendacar Foundation 2001-2025
//  (used only if Supabase can't be reached)
// =============================================================================

const ORG_CATEGORIES = {
  "Casa of McHenry County": "Children & Youth",
  "Big Brothers Big Sisters of McHenry County": "Children & Youth",
  "Big Brothers Big Sisters of Indian River": "Children & Youth",
  "Gifford Youth Achievement Center": "Children & Youth",
  "Holiday Heroes Foundation": "Children & Youth",
  "Special Olympics": "Children & Youth",
  "Youth Service Bureau": "Children & Youth",
  "Canaryville Little League": "Children & Youth",
  "Project Linus": "Children & Youth",
  "Miss B Learning Bsse": "Children & Youth",
  "Alexander Leigh Center for Autism": "Children & Youth",
  "Northern Illinois Center of Autism": "Children & Youth",
  "Parla": "Community Development",
  "Huron County Coalition Against Domestic Violence": "Domestic Violence",
  "Home of the Sparrow": "Domestic Violence",
  "Northern Illinois Food Bank": "Food & Hunger",
  "Crystal Lake Food Pantry": "Food & Hunger",
  "Food Pantry Indian River County": "Food & Hunger",
  "Treasure Coast Food Bank": "Food & Hunger",
  "Harvest Food and Outreach": "Food & Hunger",
  "Care and Share": "Food & Hunger",
  "Salvation Army": "Food & Hunger",
  "Rockford Rescue Mission": "Food & Hunger",
  "Cleveland Clinic - Indian River": "Healthcare",
  "Indian River Medical Center": "Healthcare",
  "Indian River Hospital Foundation": "Healthcare",
  "Scheurer Hospital": "Healthcare",
  "VNA and Hospice Foundation": "Healthcare",
  "Alzheimer's Association": "Healthcare",
  "Juvenile Diabetes Research Foundation": "Healthcare",
  "The Wellness Place": "Healthcare",
  "Senior Resource Associaiton": "Healthcare",
  "Riverside Theatre": "Arts & Culture",
  "Vero Beach Museum of Art": "Arts & Culture",
  "Fort Pierce Magnet School of the arts": "Arts & Culture",
  "The Learning Alliance": "Education",
  "The Learning Tree of Crystal Lake": "Education",
  "The Neighborhood Academy": "Education",
  "District 47 Giftcard Pgm": "Education",
  "Vero Beach Elementary School": "Education",
  "Educational Foundation of Indian River": "Education",
  "St. John's Northwestern Military Academy": "Education",
  "Impact 100": "Education",
  "MCC Foundation": "Education",
  "Hoover Institution": "Education",
  "CASA of McHenry County": "Children & Youth",
  "Habitat for Humanity IRC": "Community Development",
  "Village of Port Austin": "Community Development",
  "Max McGraw Wildlife Foundation": "Environment & Wildlife",
  "Enviromental Learning Center": "Environment & Wildlife",
  "Indian River Land Trust": "Environment & Wildlife",
  "Treasure Coast Manatee Foundation": "Environment & Wildlife",
  "MCKEE Botanical Garden": "Environment & Wildlife",
  "Indian River Habitat for Humanity ": "Community Development",
  "Indian River Habitat for Humanity": "Community Development",
  "Huron Community Foundation": "Community Development",
  "Huron County Community Foundation": "Community Development",
  "Huron Development Commission": "Community Development",
  "Musana Community Development Org": "Community Development",
  "Indian River Community": "Community Development",
  "Port Austin Fire Department": "Community Development",
  "Port Austin Good Fellows": "Community Development",
  "The Hope for Families Center": "Community & Social Services",
  "Daisie Bridgewater Hope Center": "Community & Social Services",
  "St. Luke N.E.W. Life Center": "Community & Social Services",
  "Options and Advocacy for McHenry County ": "Community & Social Services",
  "Options and Advocacy for McHenry County": "Community & Social Services",
  "Indian River County United Against Poverty": "Community & Social Services",
  "PADS First Congregational Church / McHenry County PADS": "Community & Social Services",
  "American Red Cross": "Community & Social Services",
  "Jaycee's": "Community & Social Services",
  "Junior Priscilla Womens CLub": "Community & Social Services",
  "Port Austin United  Protestant Church": "Religious",
  "United Protestant Church (Grayslake)": "Religious",
  "Port Austin United Protestant Church": "Religious",
};

const GRANTS = [
  { id: 176, year: 2026, org: "CASA of McHenry County", amount: 32855 },
  { id: 177, year: 2026, org: "Habitat for Humanity IRC", amount: 10000 },
  { id: 178, year: 2026, org: "The Hope for Families Center", amount: 10000 },
  { id: 179, year: 2026, org: "Village of Port Austin", amount: 62500 },
  { id: 180, year: 2026, org: "Indian River Habitat for Humanity", amount: 10000 },
  { id: 181, year: 2025, org: "Northern Illinois Food Bank", amount: 10000 },
  { id: 182, year: 2025, org: "Hoover Institution", amount: 10000 },
  { id: 1, year: 2025, org: "Big Brothers Big Sisters of McHenry County", amount: 50000 },
  { id: 2, year: 2025, org: "Parla", amount: 40000 },
  { id: 3, year: 2025, org: "Casa of McHenry County", amount: 25000 },
  { id: 4, year: 2025, org: "Indian River Habitat for Humanity", amount: 10000 },
  { id: 5, year: 2025, org: "The Learning Alliance", amount: 10000 },
  { id: 6, year: 2025, org: "Max McGraw Wildlife Foundation", amount: 7500 },
  { id: 7, year: 2024, org: "Parla", amount: 210000 },
  { id: 8, year: 2024, org: "Cleveland Clinic - Indian River", amount: 100000 },
  { id: 9, year: 2024, org: "Port Austin Fire Department", amount: 88000 },
  { id: 10, year: 2024, org: "Big Brothers Big Sisters of McHenry County", amount: 50000 },
  { id: 11, year: 2024, org: "The Hope for Families Center", amount: 20000 },
  { id: 12, year: 2024, org: "District 47 Giftcard Pgm", amount: 12000 },
  { id: 13, year: 2024, org: "Indian River Habitat for Humanity", amount: 10000 },
  { id: 14, year: 2024, org: "Northern Illinois Food Bank", amount: 10000 },
  { id: 15, year: 2024, org: "Max McGraw Wildlife Foundation", amount: 7500 },
  { id: 16, year: 2023, org: "Treasure Coast Food Bank", amount: 100000 },
  { id: 17, year: 2023, org: "District 47 Giftcard Pgm", amount: 50000 },
  { id: 18, year: 2023, org: "Big Brothers Big Sisters of McHenry County", amount: 50000 },
  { id: 19, year: 2023, org: "Indian River Habitat for Humanity", amount: 20000 },
  { id: 20, year: 2023, org: "Casa of McHenry County", amount: 20000 },
  { id: 21, year: 2023, org: "The Learning Alliance", amount: 20000 },
  { id: 22, year: 2023, org: "Big Brothers Big Sisters of Indian River", amount: 10000 },
  { id: 23, year: 2023, org: "Max McGraw Wildlife Foundation", amount: 7500 },
  { id: 24, year: 2023, org: "The Hope for Families Center", amount: 7000 },
  { id: 25, year: 2023, org: "Northern Illinois Food Bank", amount: 5000 },
  { id: 26, year: 2022, org: "Senior Resource Associaiton", amount: 50000 },
  { id: 27, year: 2022, org: "Crystal Lake Food Pantry", amount: 40000 },
  { id: 28, year: 2022, org: "District 47 Giftcard Pgm", amount: 22500 },
  { id: 29, year: 2022, org: "Indian River Habitat for Humanity", amount: 10000 },
  { id: 30, year: 2022, org: "Max McGraw Wildlife Foundation", amount: 7500 },
  { id: 31, year: 2021, org: "Max McGraw Wildlife Foundation", amount: 20500 },
  { id: 32, year: 2021, org: "Salvation Army", amount: 20000 },
  { id: 33, year: 2021, org: "The Learning Alliance", amount: 20000 },
  { id: 34, year: 2021, org: "Indian River Habitat for Humanity", amount: 15000 },
  { id: 35, year: 2021, org: "Big Brothers Big Sisters of Indian River", amount: 8000 },
  { id: 36, year: 2021, org: "Impact 100", amount: 8000 },
  { id: 37, year: 2021, org: "Riverside Theatre", amount: 5000 },
  { id: 38, year: 2021, org: "Northern Illinois Food Bank", amount: 5000 },
  { id: 39, year: 2021, org: "Junior Priscilla Womens CLub", amount: 3000 },
  { id: 40, year: 2021, org: "VNA and Hospice Foundation", amount: 3000 },
  { id: 41, year: 2020, org: "District 47 Giftcard Pgm", amount: 31345 },
  { id: 42, year: 2020, org: "Crystal Lake Food Pantry", amount: 27452 },
  { id: 43, year: 2020, org: "Huron County Coalition Against Domestic Violence", amount: 25000 },
  { id: 44, year: 2020, org: "The Learning Alliance", amount: 24000 },
  { id: 45, year: 2020, org: "Indian River Habitat for Humanity", amount: 15000 },
  { id: 46, year: 2020, org: "Indian River Medical Center", amount: 15000 },
  { id: 47, year: 2020, org: "Big Brothers Big Sisters of Indian River", amount: 8500 },
  { id: 48, year: 2020, org: "Treasure Coast Food Bank", amount: 8000 },
  { id: 49, year: 2020, org: "Junior Priscilla Womens CLub", amount: 6000 },
  { id: 50, year: 2020, org: "Riverside Theatre", amount: 5000 },
  { id: 51, year: 2020, org: "Indian River County United Against Poverty", amount: 2000 },
  { id: 52, year: 2020, org: "The Hope for Families Center", amount: 2000 },
  { id: 53, year: 2020, org: "United Protestant Church (Grayslake)", amount: 2000 },
  { id: 54, year: 2020, org: "Daisie Bridgewater Hope Center", amount: 1500 },
  { id: 55, year: 2020, org: "Impact 100", amount: 1000 },
  { id: 56, year: 2020, org: "Food Pantry Indian River County", amount: 1000 },
  { id: 57, year: 2020, org: "MCKEE Botanical Garden", amount: 500 },
  { id: 58, year: 2019, org: "The Learning Alliance", amount: 11000 },
  { id: 59, year: 2019, org: "Indian River Habitat for Humanity", amount: 10000 },
  { id: 60, year: 2019, org: "Casa of McHenry County", amount: 8000 },
  { id: 61, year: 2019, org: "District 47 Giftcard Pgm", amount: 6000 },
  { id: 62, year: 2019, org: "Riverside Theatre", amount: 5000 },
  { id: 63, year: 2019, org: "Big Brothers Big Sisters of Indian River", amount: 5000 },
  { id: 64, year: 2019, org: "Vero Beach Elementary School", amount: 5000 },
  { id: 65, year: 2019, org: "Educational Foundation of Indian River", amount: 3000 },
  { id: 66, year: 2019, org: "Miss B Learning Bsse", amount: 2500 },
  { id: 67, year: 2019, org: "Gifford Youth Achievement Center", amount: 2250 },
  { id: 68, year: 2019, org: "Treasure Coast Food Bank", amount: 2000 },
  { id: 69, year: 2019, org: "Huron Community Foundation", amount: 2000 },
  { id: 70, year: 2019, org: "Junior Priscilla Womens CLub", amount: 2000 },
  { id: 71, year: 2019, org: "Impact 100", amount: 1200 },
  { id: 72, year: 2019, org: "Salvation Army", amount: 802 },
  { id: 73, year: 2019, org: "Project Linus", amount: 250 },
  { id: 74, year: 2018, org: "Daisie Bridgewater Hope Center", amount: 11000 },
  { id: 75, year: 2018, org: "Indian River Habitat for Humanity", amount: 10000 },
  { id: 76, year: 2018, org: "Port Austin United  Protestant Church", amount: 10000 },
  { id: 77, year: 2018, org: "The Learning Alliance", amount: 10000 },
  { id: 78, year: 2018, org: "District 47 Giftcard Pgm", amount: 9293 },
  { id: 79, year: 2018, org: "Treasure Coast Manatee Foundation", amount: 9000 },
  { id: 80, year: 2018, org: "Casa of McHenry County", amount: 7000 },
  { id: 81, year: 2018, org: "Riverside Theatre", amount: 5000 },
  { id: 82, year: 2018, org: "Big Brothers Big Sisters of Indian River", amount: 5000 },
  { id: 83, year: 2018, org: "Junior Priscilla Womens CLub", amount: 2000 },
  { id: 84, year: 2018, org: "Salvation Army", amount: 1774 },
  { id: 85, year: 2018, org: "Vero Beach Elementary School", amount: 1000 },
  { id: 86, year: 2017, org: "Indian River Medical Center", amount: 15000 },
  { id: 87, year: 2017, org: "District 47 Giftcard Pgm", amount: 10568 },
  { id: 88, year: 2017, org: "Indian River Habitat for Humanity", amount: 10000 },
  { id: 89, year: 2017, org: "The Learning Alliance", amount: 10000 },
  { id: 90, year: 2017, org: "Casa of McHenry County", amount: 5000 },
  { id: 91, year: 2017, org: "Riverside Theatre", amount: 5000 },
  { id: 92, year: 2017, org: "Gifford Youth Achievement Center", amount: 3000 },
  { id: 93, year: 2017, org: "Treasure Coast Food Bank", amount: 2000 },
  { id: 94, year: 2017, org: "Options and Advocacy for McHenry County", amount: 2000 },
  { id: 95, year: 2017, org: "Holiday Heroes Foundation", amount: 2000 },
  { id: 96, year: 2017, org: "Junior Priscilla Womens CLub", amount: 2000 },
  { id: 97, year: 2017, org: "Indian River Community", amount: 1050 },
  { id: 98, year: 2017, org: "Canaryville Little League", amount: 1000 },
  { id: 99, year: 2017, org: "Daisie Bridgewater Hope Center", amount: 1000 },
  { id: 100, year: 2017, org: "Salvation Army", amount: 768 },
  { id: 101, year: 2017, org: "Indian River County United Against Poverty", amount: 500 },
  { id: 102, year: 2016, org: "Vero Beach Museum of Art", amount: 14000 },
  { id: 103, year: 2016, org: "Indian River Habitat for Humanity", amount: 10000 },
  { id: 104, year: 2016, org: "The Learning Alliance", amount: 10000 },
  { id: 105, year: 2016, org: "District 47 Giftcard Pgm", amount: 6000 },
  { id: 106, year: 2016, org: "Options and Advocacy for McHenry County", amount: 5000 },
  { id: 107, year: 2016, org: "St. Luke N.E.W. Life Center", amount: 5000 },
  { id: 108, year: 2016, org: "Holiday Heroes Foundation", amount: 3500 },
  { id: 109, year: 2016, org: "Fort Pierce Magnet School of the arts", amount: 2000 },
  { id: 110, year: 2016, org: "Canaryville Little League", amount: 1500 },
  { id: 111, year: 2015, org: "Indian River Hospital Foundation", amount: 30000 },
  { id: 112, year: 2015, org: "Enviromental Learning Center", amount: 10100 },
  { id: 113, year: 2015, org: "Indian River Habitat for Humanity", amount: 10000 },
  { id: 114, year: 2015, org: "Parla", amount: 5000 },
  { id: 115, year: 2015, org: "Casa of McHenry County", amount: 5000 },
  { id: 116, year: 2015, org: "Gifford Youth Achievement Center", amount: 5000 },
  { id: 117, year: 2015, org: "Canaryville Little League", amount: 2500 },
  { id: 118, year: 2015, org: "Harvest Food and Outreach", amount: 2500 },
  { id: 119, year: 2015, org: "Treasure Coast Food Bank", amount: 2000 },
  { id: 120, year: 2014, org: "Huron County Coalition Against Domestic Violence", amount: 39750 },
  { id: 121, year: 2014, org: "Enviromental Learning Center", amount: 4900 },
  { id: 122, year: 2014, org: "Northern Illinois Center of Autism", amount: 2500 },
  { id: 123, year: 2014, org: "Casa of McHenry County", amount: 2500 },
  { id: 124, year: 2014, org: "Musana Community Development Org", amount: 2500 },
  { id: 125, year: 2014, org: "Care and Share", amount: 2000 },
  { id: 126, year: 2014, org: "Indian River Habitat for Humanity", amount: 1500 },
  { id: 127, year: 2013, org: "Enviromental Learning Center", amount: 7000 },
  { id: 128, year: 2013, org: "The Neighborhood Academy", amount: 5000 },
  { id: 129, year: 2013, org: "Alexander Leigh Center for Autism", amount: 2500 },
  { id: 130, year: 2013, org: "MCC Foundation", amount: 1000 },
  { id: 131, year: 2013, org: "Indian River Habitat for Humanity", amount: 1000 },
  { id: 132, year: 2013, org: "Indian River Land Trust", amount: 500 },
  { id: 133, year: 2012, org: "Huron County Coalition Against Domestic Violence", amount: 6270 },
  { id: 134, year: 2012, org: "Enviromental Learning Center", amount: 3500 },
  { id: 135, year: 2012, org: "The Neighborhood Academy", amount: 1000 },
  { id: 136, year: 2011, org: "Huron County Coalition Against Domestic Violence", amount: 12000 },
  { id: 137, year: 2011, org: "Salvation Army", amount: 2158 },
  { id: 138, year: 2011, org: "Parla", amount: 1000 },
  { id: 139, year: 2011, org: "MCC Foundation", amount: 350 },
  { id: 140, year: 2010, org: "Huron County Coalition Against Domestic Violence", amount: 84403 },
  { id: 141, year: 2010, org: "The Learning Tree of Crystal Lake", amount: 150 },
  { id: 142, year: 2009, org: "Huron County Coalition Against Domestic Violence", amount: 60000 },
  { id: 143, year: 2008, org: "Huron County Coalition Against Domestic Violence", amount: 50000 },
  { id: 144, year: 2008, org: "Youth Service Bureau", amount: 250 },
  { id: 145, year: 2007, org: "Huron County Coalition Against Domestic Violence", amount: 100000 },
  { id: 146, year: 2007, org: "The Neighborhood Academy", amount: 100 },
  { id: 147, year: 2007, org: "Scheurer Hospital", amount: 100 },
  { id: 148, year: 2006, org: "Huron County Coalition Against Domestic Violence", amount: 59456 },
  { id: 149, year: 2005, org: "Huron County Coalition Against Domestic Violence", amount: 50000 },
  { id: 150, year: 2005, org: "Alzheimer's Association", amount: 200 },
  { id: 151, year: 2005, org: "Huron County Community Foundation", amount: 200 },
  { id: 152, year: 2005, org: "The Neighborhood Academy", amount: 100 },
  { id: 153, year: 2005, org: "Scheurer Hospital", amount: 100 },
  { id: 154, year: 2004, org: "Huron County Coalition Against Domestic Violence", amount: 58250 },
  { id: 155, year: 2004, org: "The Neighborhood Academy", amount: 500 },
  { id: 156, year: 2004, org: "Care and Share", amount: 200 },
  { id: 157, year: 2003, org: "Huron Community Foundation", amount: 18405 },
  { id: 158, year: 2003, org: "Huron Development Commission", amount: 1000 },
  { id: 159, year: 2003, org: "St. John's Northwestern Military Academy", amount: 500 },
  { id: 160, year: 2002, org: "Care and Share", amount: 1500 },
  { id: 161, year: 2002, org: "Huron Community Foundation", amount: 1500 },
  { id: 162, year: 2002, org: "Port Austin Good Fellows", amount: 1000 },
  { id: 163, year: 2002, org: "Jaycee's", amount: 600 },
  { id: 164, year: 2002, org: "PADS First Congregational Church / McHenry County PADS", amount: 500 },
  { id: 165, year: 2002, org: "St. John's Northwestern Military Academy", amount: 500 },
  { id: 166, year: 2002, org: "The Wellness Place", amount: 500 },
  { id: 167, year: 2002, org: "Rockford Rescue Mission", amount: 200 },
  { id: 168, year: 2002, org: "Home of the Sparrow", amount: 100 },
  { id: 169, year: 2002, org: "Alzheimer's Association", amount: 50 },
  { id: 170, year: 2002, org: "Special Olympics", amount: 50 },
  { id: 171, year: 2001, org: "American Red Cross", amount: 200 },
  { id: 172, year: 2001, org: "Juvenile Diabetes Research Foundation", amount: 50 },
  { id: 173, year: 2001, org: "PADS First Congregational Church / McHenry County PADS", amount: 50 },
  { id: 174, year: 2001, org: "Home of the Sparrow", amount: 50 },
  { id: 175, year: 2001, org: "Rockford Rescue Mission", amount: 27 },
].map(g => ({ ...g, category: ORG_CATEGORIES[g.org] || "Community & Social Services" }));

const DONATIONS_RECEIVED = [
  { id: 1, year: 2000, donor: "Chris & Dave Smith", amount: 149224 },
  { id: 2, year: 2001, donor: "Chris & Dave Smith", amount: 15966 },
  { id: 3, year: 2001, donor: "Kendra C. Smith", amount: 5000 },
  { id: 4, year: 2001, donor: "David P. Smith III", amount: 5000 },
  { id: 5, year: 2001, donor: "Carla S. Dobbeck", amount: 5000 },
  { id: 6, year: 2002, donor: "Chris & Dave Smith", amount: 1000 },
  { id: 7, year: 2004, donor: "Chris & Dave Smith", amount: 82247 },
  { id: 8, year: 2005, donor: "Chris & Dave Smith", amount: 123629 },
  { id: 9, year: 2006, donor: "Chris & Dave Smith", amount: 160411 },
  { id: 10, year: 2007, donor: "Chris & Dave Smith", amount: 50000 },
  { id: 11, year: 2008, donor: "Chris & Dave Smith", amount: 50000 },
  { id: 12, year: 2009, donor: "Chris & Dave Smith", amount: 315000 },
  { id: 13, year: 2010, donor: "Chris & Dave Smith", amount: 125000 },
  { id: 14, year: 2011, donor: "Chris & Dave Smith", amount: 50000 },
  { id: 15, year: 2012, donor: "Chris & Dave Smith", amount: 101662 },
  { id: 16, year: 2015, donor: "Chris & Dave Smith", amount: 125920 },
  { id: 17, year: 2018, donor: "Chris & Dave Smith", amount: 291776 },
  { id: 18, year: 2019, donor: "Chris & Dave Smith", amount: 393497 },
  { id: 19, year: 2021, donor: "Chris & Dave Smith", amount: 225000 },
  { id: 20, year: 2022, donor: "Chris & Dave Smith", amount: 300000 },
  { id: 21, year: 2023, donor: "Chris & Dave Smith", amount: 69804 },
  { id: 22, year: 2024, donor: "Chris & Dave Smith", amount: 400000 },
  { id: 23, year: 2025, donor: "Chris & Dave Smith", amount: 323247 },
];

// =============================================================================
//  INVESTMENT DATA  (from 2024 Form 990-PF / Aug 2025 statements)
//  --- These are the only figures that need a manual refresh each year.
//      Update the four numbers below and the dashboard recalculates. ---
// =============================================================================

const FALLBACK_INVESTMENTS = {
  asOf: "June 14, 2026",
  source: "Addepar portfolio",
  accounts: 4,
  composition: [
    { name: "Equities",     value: 5204689 },
    { name: "Fixed Income", value: 236764 },
    { name: "Cash",         value: 57195 },
  ],
  dividendsInterest: 0,
};

// =============================================================================
//  FALLBACK GRANTEE NOTES  (optional context shown on a grantee's detail page)
// =============================================================================

const FALLBACK_GRANTEE_NOTES = {
  "CASA of McHenry County": {
    contact: "Becky Morris, Executive Director",
    website: "https://www.casamchenrycounty.org",
    note: "Kendacar's 2026 commitment represents a meaningful share of CASA's annual operating budget. Becky Morris is providing progress benchmarks tied to the grant.",
  },
};

// The bundle the app starts with (instantly visible), replaced by live Supabase
// data once it loads.
const FALLBACK_DATA = {
  grants: GRANTS,
  donations: DONATIONS_RECEIVED,
  investments: FALLBACK_INVESTMENTS,
  granteeNotes: FALLBACK_GRANTEE_NOTES,
  granteeUpdates: {},
  granteePrograms: {},
};

const DataContext = createContext(FALLBACK_DATA);
const useData = () => useContext(DataContext);

// =============================================================================
//  FORMS  (repoint these to your live Google Form when ready)
//  Leave blank to show a "coming soon" state on the buttons.
// =============================================================================

const GRANT_REQUEST_URL = "";   // e.g. "https://forms.gle/xxxxxxxx"
const CONTRIBUTION_URL  = "";   // e.g. "https://forms.gle/yyyyyyyy"

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

function EdInput({ value, onChange, type = "text", placeholder }) {
  return <input type={type} value={value} placeholder={placeholder}
    onChange={e => onChange(e.target.value)} style={inputStyle} />;
}
function EdSelect({ value, onChange, options }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)} style={{ ...inputStyle, cursor: "pointer" }}>
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

function MiniButton({ onClick, children, kind, disabled }) {
  const colors = {
    save:   { bg: TEAL, fg: "#fff", bd: TEAL },
    cancel: { bg: "#fff", fg: "#7C8C8A", bd: "#E2D7C9" },
    delete: { bg: "#fff", fg: "#B5451B", bd: "#E3C3B6" },
    edit:   { bg: "#FBF4EC", fg: TEAL, bd: "#EFE7DD" },
  }[kind] || { bg: "#fff", fg: TEAL, bd: "#E2D7C9" };
  return (
    <button onClick={onClick} disabled={disabled} style={{
      background: colors.bg, color: colors.fg, border: "1px solid " + colors.bd, borderRadius: 6,
      padding: "5px 11px", fontSize: 12, fontWeight: 600, cursor: disabled ? "default" : "pointer",
      opacity: disabled ? 0.5 : 1, fontFamily: "'Nunito Sans', sans-serif",
    }}>{children}</button>
  );
}

// Inline editor for a single grant row (id null => adding a new grant).
function GrantEditRow({ row, onDone, narrow }) {
  const { session, setSession } = useAuth();
  const { refresh } = useData();
  const [year, setYear] = useState(row?.year ?? new Date().getFullYear());
  const [org, setOrg] = useState(row?.org ?? "");
  const [amount, setAmount] = useState(row?.amount ?? "");
  const [category, setCategory] = useState(row?.category ?? CATEGORY_LIST[0]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function save() {
    if (!org.trim() || amount === "" || isNaN(Number(amount)) || isNaN(Number(year))) {
      setErr("Year, organization and a numeric amount are required."); return;
    }
    setBusy(true); setErr("");
    const payload = { year: Number(year), org: org.trim(), amount: Number(amount), category };
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
      <td style={{ padding: "8px 12px" }}><EdInput value={org} onChange={setOrg} placeholder="Organization" /></td>
      <td style={{ padding: "8px 12px" }}><EdSelect value={category} onChange={setCategory} options={CATEGORY_LIST} /></td>
      <td style={{ padding: "8px 12px" }}><EdInput type="number" value={amount} onChange={setAmount} placeholder="Amount" /></td>
      <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
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
function SignInControl() {
  const { signedIn, email, signOut, startSignIn } = useAuth();
  const [open, setOpen] = useState(false);
  const [addr, setAddr] = useState("");
  const [state, setState] = useState("idle"); // idle | sending | sent | error
  const [msg, setMsg] = useState("");

  async function submit() {
    if (!addr.trim()) return;
    setState("sending"); setMsg("");
    try { await startSignIn(addr.trim()); setState("sent"); }
    catch (e) { setState("error"); setMsg(e.message); }
  }

  if (signedIn) {
    return (
      <div style={{ fontSize: 12, color: "#7C8C8A", marginTop: 10 }}>
        Signed in as {email} ·{" "}
        <button onClick={signOut} style={{ background: "none", border: "none", color: TEAL, cursor: "pointer", fontSize: 12, fontWeight: 600, textDecoration: "underline" }}>Sign out</button>
      </div>
    );
  }
  if (!open) {
    return (
      <div style={{ marginTop: 10 }}>
        <button onClick={() => setOpen(true)} style={{ background: "none", border: "none", color: "#B2A793", cursor: "pointer", fontSize: 11, letterSpacing: "0.06em" }}>Sign in to edit</button>
      </div>
    );
  }
  return (
    <div style={{ marginTop: 12, display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
      {state === "sent" ? (
        <div style={{ fontSize: 13, color: TEAL }}>Check your email for a sign-in link, then come back to this page.</div>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
          <input value={addr} onChange={e => setAddr(e.target.value)} placeholder="your email"
            onKeyDown={e => e.key === "Enter" && submit()}
            style={{ ...inputStyle, width: 220, fontSize: 13 }} />
          <MiniButton kind="save" onClick={submit} disabled={state === "sending"}>{state === "sending" ? "Sending…" : "Send link"}</MiniButton>
          <MiniButton kind="cancel" onClick={() => setOpen(false)}>Cancel</MiniButton>
        </div>
      )}
      {state === "error" && <div style={{ color: "#B5451B", fontSize: 12 }}>{msg}</div>}
    </div>
  );
}

// =============================================================================
//  NAV BAR
// =============================================================================

function NavBar({ view, setView, narrow }) {
  const items = [
    { id: "pulse",         label: "Pulse" },
    { id: "investments",   label: "Investments" },
    { id: "grants",        label: "Grants Made" },
    { id: "contributions", label: "Contributions" },
    { id: "grantees",      label: "Grantees" },
  ];
  const active = view === "grantee-detail" ? "grantees" : view;
  return (
    <div style={{ background: TEAL, color: "#fff", position: "sticky", top: 0, zIndex: 50, boxShadow: "0 2px 8px rgba(0,0,0,0.12)" }}>
      <div style={{ maxWidth: 1140, margin: "0 auto", padding: narrow ? "0 16px" : "0 40px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <button onClick={() => setView("pulse")} style={{ background: "none", border: "none", cursor: "pointer", padding: "12px 0", display: "flex", alignItems: "center" }}>
          <Wordmark size={21} light sub={false} />
        </button>
        <div style={{ display: "flex", gap: narrow ? 2 : 6, flexWrap: "wrap" }}>
          {items.map(it => (
            <button key={it.id} onClick={() => setView(it.id)} style={{
              background: active === it.id ? "rgba(255,255,255,0.16)" : "none",
              border: "none", color: active === it.id ? "#fff" : "#BFE0DE",
              fontFamily: "'Nunito Sans', sans-serif", fontWeight: active === it.id ? 600 : 400,
              fontSize: 13, padding: narrow ? "10px 9px" : "10px 14px", borderRadius: 6, cursor: "pointer",
            }}>{it.label}</button>
          ))}
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
  const { grants, donations, investments } = useData();
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
                <div style={{ fontSize: 14, fontWeight: 600, color: "#1F3A38", marginBottom: 8, lineHeight: 1.25 }}>{g.org}</div>
                <div style={{ fontFamily: "'Fredoka', serif", fontWeight: 700, fontSize: 24, color: TEAL }}>{fmt(g.amount)}</div>
                <div style={{ fontSize: 11, color: c, marginTop: 8, fontWeight: 600 }}>{g.category} &rarr;</div>
              </button>
            );
          })}
        </div>

        {/* CTAs */}
        <Card style={{ padding: narrow ? "22px" : "26px 30px", marginBottom: 40, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 16, background: "#FBF4EC" }}>
          <div>
            <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 22, color: INK }}>Take part</div>
            <div style={{ fontSize: 14, color: "#7C8C8A", marginTop: 4, fontFamily: FONT_BODY }}>Recommend a grant, or record a contribution to the fund.</div>
          </div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <button onClick={() => setView("request-grant")} style={{ background: CORAL, color: "#fff", border: "none", borderRadius: 12, padding: "12px 22px", fontSize: 14.5, fontWeight: 700, fontFamily: FONT_BODY, cursor: "pointer" }}>Recommend a Grant</button>
            <button onClick={() => setView("contribute")} style={{ background: "#fff", color: TEAL, border: "1.5px solid " + TEAL, borderRadius: 12, padding: "12px 22px", fontSize: 14.5, fontWeight: 700, fontFamily: FONT_BODY, cursor: "pointer" }}>Make a Contribution</button>
          </div>
        </Card>

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

        <div style={{ marginTop: 36, textAlign: "center" }}>
          <a href="./kendacar_scenarios.html" target="_blank" rel="noopener noreferrer" style={{ color: TEAL, fontSize: 13, fontWeight: 600, textDecoration: "none", fontFamily: "'Nunito Sans', sans-serif" }}>
            View 40-year giving scenarios &rarr;
          </a>
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

function InvestmentsView({ narrow }) {
  const { investments } = useData();
  const { signedIn } = useAuth();
  const [editing, setEditing] = useState(false);
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
        <StatCard label="Accounts" value={investments.accounts || "—"} sub="managed & brokerage" accent={CORAL} />
        <StatCard label="Asset Classes" value={data.length} sub="equities, fixed income, cash" accent={SUN} />
      </div>

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
            By asset class, as of {investments.asOf}. Account-level statements and individual holdings stay private in Addepar — this page shows allocation only.
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
  const { grants } = useData();
  const { signedIn } = useAuth();
  const [yearFilter, setYearFilter] = useState("All Years");
  const [orgFilter,  setOrgFilter]  = useState("All Organizations");
  const [catFilter,  setCatFilter]  = useState("All Categories");
  const [tab, setTab] = useState("grants");
  const [editId, setEditId] = useState(null); // grant id being edited, or "new"

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
    <div style={{ maxWidth: 1140, margin: "0 auto", padding: narrow ? "28px 16px" : "36px 40px" }}>
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
              <MiniButton kind="edit" onClick={() => setEditId(editId === "new" ? null : "new")}>{editId === "new" ? "Close" : "+ Add grant"}</MiniButton>
            </div>
          )}
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: signedIn ? 640 : 520 }}>
              <thead>
                <tr style={{ background: "#FFF8F2", borderBottom: "1px solid #EFE7DD" }}>
                  {["Year", "Organization", "Category", "Amount"].concat(signedIn ? ["Edit"] : []).map(h => (
                    <th key={h} style={{ padding: "12px 16px", textAlign: "left", fontFamily: "'Fredoka', serif", fontWeight: 600, fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "#7C8C8A", whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {signedIn && editId === "new" && <GrantEditRow row={null} onDone={() => setEditId(null)} narrow={narrow} />}
                {filtered.length === 0 && <tr><td colSpan={signedIn ? 5 : 4} style={{ padding: 32, textAlign: "center", color: "#7C8C8A" }}>No grants match your filters.</td></tr>}
                {filtered.slice().sort((a, b) => b.year - a.year || b.amount - a.amount).map((g, i) => (
                  editId === g.id && g.id != null ? (
                    <GrantEditRow key={"edit" + g.id} row={g} onDone={() => setEditId(null)} narrow={narrow} />
                  ) : (
                  <tr key={g.id ?? g.org + g.year + i} style={{ borderBottom: "1px solid #F3ECE3", background: i % 2 === 0 ? "#fff" : "#FCF7F1" }}>
                    <td style={{ padding: "11px 16px", color: "#7C8C8A", fontWeight: 500 }}>{g.year}</td>
                    <td style={{ padding: "11px 16px", fontWeight: 500 }}>{g.org}</td>
                    <td style={{ padding: "11px 16px" }}>
                      <span style={{ background: (CAT_COLORS[g.category] || "#999") + "18", color: CAT_COLORS[g.category] || "#999", borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}>{g.category}</span>
                    </td>
                    <td style={{ padding: "11px 16px", fontWeight: 700, color: TEAL, whiteSpace: "nowrap" }}>{fmt(g.amount)}</td>
                    {signedIn && (
                      <td style={{ padding: "11px 16px" }}>
                        {g.id != null
                          ? <MiniButton kind="edit" onClick={() => setEditId(g.id)}>Edit</MiniButton>
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
  const { donations } = useData();
  const { signedIn } = useAuth();
  const [editId, setEditId] = useState(null);
  const totalReceived = sumAmount(donations);
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
            {signedIn && <MiniButton kind="edit" onClick={() => setEditId(editId === "new" ? null : "new")}>{editId === "new" ? "Close" : "+ Add"}</MiniButton>}
          </div>
          <div style={{ maxHeight: 340, overflowY: "auto", overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: signedIn ? 480 : 360 }}>
              <thead>
                <tr style={{ background: "#FFF8F2" }}>
                  {["Year", "Donor", "Amount"].concat(signedIn ? ["Edit"] : []).map(h => (
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
                  <tr key={d.id ?? d.donor + d.year + i} style={{ borderBottom: "1px solid #F3ECE3", background: i % 2 === 0 ? "#fff" : "#FCF7F1" }}>
                    <td style={{ padding: "10px 16px", color: "#7C8C8A" }}>{d.year}</td>
                    <td style={{ padding: "10px 16px", fontWeight: 500 }}>{d.donor}</td>
                    <td style={{ padding: "10px 16px", fontWeight: 700, color: TEAL }}>{fmt(d.amount)}</td>
                    {signedIn && <td style={{ padding: "10px 16px" }}>{d.id != null ? <MiniButton kind="edit" onClick={() => setEditId(d.id)}>Edit</MiniButton> : <span style={{ fontSize: 11, color: "#C8BBA8" }}>—</span>}</td>}
                  </tr>
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

function buildGranteeIndex(grants) {
  const map = {};
  grants.forEach(g => {
    const key = normalizeOrg(g.org);
    if (!map[key]) map[key] = { org: key, total: 0, count: 0, years: new Set(), category: g.category, grants: [] };
    map[key].total += g.amount;
    map[key].count += 1;
    map[key].years.add(g.year);
    map[key].grants.push(g);
  });
  return Object.values(map).map(o => ({
    ...o,
    firstYear: Math.min(...o.years),
    lastYear: Math.max(...o.years),
    yearCount: o.years.size,
  })).sort((a, b) => b.total - a.total);
}

function GranteesDirectory({ goGrantee, narrow }) {
  const { grants, granteeNotes } = useData();
  const index = useMemo(() => buildGranteeIndex(grants), [grants]);
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
    description: note?.description || "",
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

function GranteeDetail({ org, setView, goGrantee, narrow }) {
  const { grants, granteeNotes, granteeUpdates, granteePrograms } = useData();
  const { signedIn, session, setSession } = useAuth();
  const { refresh } = useData();
  const index = useMemo(() => buildGranteeIndex(grants), [grants]);
  const rec = index.find(o => o.org === org);
  const note = granteeNotes[org];
  const updates = granteeUpdates[org] || [];
  const programs = granteePrograms[org] || [];
  const [editingProfile, setEditingProfile] = useState(false);
  const [composing, setComposing] = useState(false);
  const [editingProgram, setEditingProgram] = useState(null); // null | "new" | program object
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
            <div style={{ fontSize: 13, color: "#7C8C8A", fontFamily: FONT_BODY }}>Grantee #{rank} by total support &middot; supported across {rec.yearCount} year{rec.yearCount > 1 ? "s" : ""}</div>
            {note && note.website && (
              <a href={note.website} target="_blank" rel="noopener noreferrer" style={{ display: "inline-block", marginTop: 10, color: TEAL, fontSize: 13.5, fontWeight: 700, textDecoration: "none", fontFamily: FONT_BODY }}>Visit website &rarr;</a>
            )}
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 11, fontFamily: FONT_BODY, fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase", color: "#7C8C8A" }}>Total Received</div>
            <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 40, color: TEAL, lineHeight: 1 }}>{fmt(rec.total)}</div>
            <div style={{ fontSize: 12, color: "#7C8C8A", marginTop: 4 }}>{rec.count} grant{rec.count > 1 ? "s" : ""} &middot; {rec.firstYear}&ndash;{rec.lastYear}</div>
            {signedIn && !editingProfile && <div style={{ marginTop: 10 }}><MiniButton kind="edit" onClick={() => setEditingProfile(true)}>Edit profile</MiniButton></div>}
          </div>
        </div>
        {note && (note.description || note.contact) && (
          <div style={{ marginTop: 20, paddingTop: 18, borderTop: "1px solid " + LINE }}>
            {note.description && <div style={{ fontSize: 14.5, color: INK, lineHeight: 1.6, maxWidth: 740, fontFamily: FONT_BODY, marginBottom: note.contact ? 12 : 0 }}>{note.description}</div>}
            {note.contact && (
              <div style={{ fontSize: 13.5, color: "#5E6E6C", fontFamily: FONT_BODY }}>
                <strong style={{ color: INK }}>{note.contact}</strong>{note.contactRole ? " · " + note.contactRole : ""}
                {note.contactEmail && <> · <a href={"mailto:" + note.contactEmail} style={{ color: TEAL, fontWeight: 700, textDecoration: "none" }}>{note.contactEmail}</a></>}
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
          <div style={{ maxHeight: 300, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#FFF8F2" }}>
                  {["Year", "Amount"].map(h => (
                    <th key={h} style={{ padding: "10px 16px", textAlign: "left", fontFamily: "'Fredoka', serif", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "#7C8C8A" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rec.grants.slice().sort((a, b) => b.year - a.year).map((g, i) => (
                  <tr key={g.year + "-" + i} style={{ borderBottom: "1px solid #F3ECE3", background: i % 2 === 0 ? "#fff" : "#FCF7F1" }}>
                    <td style={{ padding: "10px 16px", color: "#7C8C8A" }}>{g.year}</td>
                    <td style={{ padding: "10px 16px", fontWeight: 700, color: TEAL }}>{fmt(g.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
      await publicInsert("grant_requests", {
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
  const [donor, setDonor] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (!donor.trim() || amount === "" || isNaN(Number(amount))) { setErr("Please add your name and a numeric amount."); return; }
    setBusy(true); setErr("");
    try {
      await publicInsert("contributions", { donor: donor.trim(), amount: Number(amount), note: note.trim() || null });
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
        <FormField label="Amount">
          <input type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="$" style={formInput} />
        </FormField>
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
  const { refresh } = useData();
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
      // 1) create the grant
      await authedWrite(session, setSession, "POST", "grants",
        { year: yr, org: req.org, amount: Number(amount), category: req.category || ORG_CATEGORIES[req.org] || "Community & Social Services" });
      // 2) mark the recommendation as sent
      await authedWrite(session, setSession, "PATCH", "grant_requests?id=eq." + req.id,
        { status: "sent", check_date: date || null, check_number: checkNo.trim() || null, processed_at: new Date().toISOString() });
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

  async function load() {
    try {
      setItems(await authedGet(session, setSession, "grant_requests?status=eq.new&order=created_at.desc&select=id,org,amount,requested_by,requester_email,category,notes,created_at"));
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

  return (
    <div style={{ maxWidth: 880, margin: "0 auto", padding: narrow ? "28px 16px" : "36px 40px" }}>
      <button onClick={() => setView("pulse")} style={{ background: "none", border: "none", color: TEAL, cursor: "pointer", fontSize: 13, fontWeight: 700, marginBottom: 16, fontFamily: FONT_BODY }}>&larr; Back to dashboard</button>
      <SectionTitle title="Grant recommendations to process" sub="Family submissions waiting to be sent. Confirm one and it posts to the dashboard automatically." />

      {err && <div style={{ color: "#B5451B", fontSize: 13, marginBottom: 12 }}>{err}</div>}
      {items === null && !err && <div style={{ color: "#7C8C8A", fontFamily: FONT_BODY }}>Loading…</div>}
      {items && items.length === 0 && (
        <Card style={{ padding: "30px 24px", textAlign: "center", color: "#9B8E80", fontFamily: FONT_BODY }}>Nothing waiting — you're all caught up. 🎉</Card>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {(items || []).map(r => (
          <Card key={r.id} style={{ padding: narrow ? "18px" : "20px 24px", borderLeft: "4px solid " + CORAL }}>
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
                <div style={{ fontSize: 11, color: "#7C8C8A", fontWeight: 700, fontFamily: FONT_BODY }}>SUGGESTED</div>
                <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 24, color: TEAL }}>{r.amount != null ? fmt(r.amount) : "—"}</div>
              </div>
            </div>
            {openId === r.id ? (
              <MarkSentRow req={r} onDone={after} />
            ) : (
              <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                <MiniButton kind="save" onClick={() => setOpenId(r.id)}>Mark sent →</MiniButton>
                <MiniButton kind="delete" onClick={() => dismiss(r.id)}>Dismiss</MiniButton>
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

export default function App() {
  const [view, setView] = useState("pulse");
  const [selectedOrg, setSelectedOrg] = useState(null);
  const [data, setData] = useState(FALLBACK_DATA);  // instant render from baked-in copy
  const [source, setSource] = useState("fallback"); // "fallback" | "live"
  const [session, setSession] = useState(null);
  const [pending, setPending] = useState(0);        // count of new submissions
  const width = useWindowWidth();
  const narrow = width < 720;

  const refreshPending = async (sess) => {
    const s = sess || session;
    if (!s) { setPending(0); return; }
    try { const rows = await authedGet(s, setSession, "grant_requests?status=eq.new&select=id"); setPending(rows.length); }
    catch { /* ignore */ }
  };

  // Reusable loader so edits can refresh the page data after a write.
  const loadData = async () => {
    try {
      const live = await fetchLiveData();
      if (live && live.grants.length) { setData(live); setSource("live"); }
      return live;
    } catch { /* keep fallback */ }
  };

  // On load: capture a magic-link session from the URL (or restore a saved one),
  // then pull live data.
  useEffect(() => {
    const fromHash = sessionFromHash();
    const existing = fromHash || loadSession();
    if (fromHash) saveSession(fromHash);
    if (existing) {
      if (existing.expires_at && existing.expires_at < Date.now()) {
        refreshSession(existing).then(r => { if (r) { setSession(r); saveSession(r); } else { saveSession(null); } });
      } else setSession(existing);
    }
    // Deep-link to a form page (shareable links like .../Kendacar/#request-grant)
    const h = window.location.hash.replace("#", "");
    if (h === "request-grant" || h === "contribute") setView(h);
    loadData();
  }, []);

  // Keep the "new submissions" badge current whenever the signed-in user changes.
  useEffect(() => { refreshPending(session); /* eslint-disable-next-line */ }, [session]);

  function nav(v) {
    setView(v); setSelectedOrg(null);
    const hashView = v === "request-grant" || v === "contribute";
    history.replaceState(null, "", window.location.pathname + window.location.search + (hashView ? "#" + v : ""));
    window.scrollTo({ top: 0 });
  }
  function goGrantee(org) { setSelectedOrg(org); setView("grantee-detail"); window.scrollTo({ top: 0 }); }

  const auth = {
    session, setSession,
    signedIn: !!session,
    email: session?.email || "",
    startSignIn: email => sendMagicLink(email),
    signOut: () => { setSession(null); saveSession(null); },
  };

  return (
    <AuthContext.Provider value={auth}>
      <DataContext.Provider value={{ ...data, refresh: loadData, live: source === "live" }}>
        <div style={{ minHeight: "100vh", background: "#FFF8F2", fontFamily: "'Nunito Sans', sans-serif", color: "#1F3A38" }}>
          <NavBar view={view} setView={nav} narrow={narrow} />

          {auth.signedIn && (
            <div style={{ background: "#0E7A5F", color: "#fff", textAlign: "center", fontSize: 12, padding: "7px 16px", fontFamily: "'Nunito Sans', sans-serif" }}>
              Edit mode — signed in as {auth.email}. ·{" "}
              <button onClick={() => setView("queue")} style={{ background: "none", border: "none", color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 700, textDecoration: "underline" }}>Review submissions</button>
              {pending > 0 && <span style={{ background: CORAL, color: "#fff", borderRadius: 20, padding: "1px 8px", fontSize: 11, fontWeight: 800, marginLeft: 6 }}>{pending}</span>} ·{" "}
              <button onClick={auth.signOut} style={{ background: "none", border: "none", color: "#CFEFE5", cursor: "pointer", fontSize: 12, fontWeight: 600, textDecoration: "underline" }}>Sign out</button>
            </div>
          )}

          {view === "pulse"          && <PulseLanding setView={nav} goGrantee={goGrantee} narrow={narrow} />}
          {view === "investments"    && <InvestmentsView narrow={narrow} />}
          {view === "grants"         && <GrantsView narrow={narrow} />}
          {view === "contributions"  && <ContributionsView narrow={narrow} />}
          {view === "grantees"       && <GranteesDirectory goGrantee={goGrantee} narrow={narrow} />}
          {view === "grantee-detail" && <GranteeDetail org={selectedOrg} setView={nav} goGrantee={goGrantee} narrow={narrow} />}
          {view === "request-grant"  && <RequestGrantForm narrow={narrow} setView={nav} />}
          {view === "contribute"     && <ContributionForm narrow={narrow} setView={nav} />}
          {view === "queue"          && auth.signedIn && <ProcessingQueue narrow={narrow} setView={nav} onChange={() => refreshPending(session)} />}

          <div style={{ padding: "32px 20px", textAlign: "center", fontSize: 11, color: "#7C8C8A", fontFamily: "'Fredoka', serif", letterSpacing: "0.08em" }}>
            KENDACAR FOUNDATION &middot; CONFIDENTIAL &middot; FOR FAMILY USE ONLY
            {source === "live" && <span style={{ color: "#B7CFCF" }}> &middot; live data</span>}
            <SignInControl />
          </div>
        </div>
      </DataContext.Provider>
    </AuthContext.Provider>
  );
}

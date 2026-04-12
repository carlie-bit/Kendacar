# Kendacar Foundation — Grant Dashboard

A private family grant history dashboard for the Kendacar Foundation.

## Live URL
Once deployed, your dashboard will be live at:
`https://YOUR-GITHUB-USERNAME.github.io/kendacar-dashboard/`

---

## One-Time Setup

### 1. Create the GitHub repo
1. Go to [github.com](https://github.com) → **New repository**
2. Name it exactly: `kendacar-dashboard`
3. Set it to **Private** (recommended)
4. Do **not** initialize with a README (you have one already)

### 2. Enable GitHub Pages
1. In your new repo → **Settings** → **Pages**
2. Under *Source*, select **GitHub Actions**
3. Save

### 3. Upload these files
Option A — GitHub web UI (easiest):
1. Drag and drop all files from this zip into the repo's root
2. Commit directly to `main`

Option B — Git command line:
```bash
git init
git remote add origin https://github.com/YOUR-USERNAME/kendacar-dashboard.git
git add .
git commit -m "Initial deploy"
git push -u origin main
```

### 4. Watch it deploy
- Go to your repo → **Actions** tab
- You'll see a workflow run called "Deploy to GitHub Pages"
- Takes about 60 seconds
- When it shows a green ✓, your URL is live

---

## Making Design Changes

Edit `src/App.jsx` — this is the entire dashboard.

Key things to customize:
- **`GRANTS` array** (line ~10) — replace sample data with your real grant history
- **`DONATIONS_RECEIVED` array** — replace with real incoming donations
- **`ORGS` / `CATEGORIES`** — update dropdown options
- **Colors** — `CAT_COLORS` object maps each category to a hex color
- **Foundation name / branding** — search for "Kendacar" to find all text instances

After any edit, just commit and push to `main` — GitHub Actions redeploys automatically (about 60 seconds).

---

## Running Locally (optional)

```bash
npm install
npm run dev
```
Then open `http://localhost:5173/kendacar-dashboard/`

---

## Connecting to Live Google Sheets Data (future upgrade)

Replace the `GRANTS` and `DONATIONS_RECEIVED` arrays in `App.jsx` with a `fetch()` call to your published Google Sheet:

1. In Google Sheets → **File → Share → Publish to web** → choose your sheet → **CSV**
2. Copy the URL
3. In `App.jsx`, replace the static arrays with:

```javascript
const [grants, setGrants] = useState([]);
useEffect(() => {
  fetch('YOUR_PUBLISHED_CSV_URL')
    .then(r => r.text())
    .then(csv => setGrants(parseCSV(csv)));
}, []);
```

Happy to build this out when you're ready.

# Chromatogram Peak Annotator

A browser-based annotation tool for chromatogram peaks, used in a human-subjects study comparing AI visualization conditions.

## Repository structure

```
index.html          ← entry point (loads App.jsx via Babel)
App.jsx             ← full React app (no build step needed)
.nojekyll           ← tells GitHub Pages not to run Jekyll
data/
  manifest.json     ← list of dataset folder names
  12_1_control/
    12_1_control.csv
    12_1_control_explanations.json
    12_1_control_groundtruthlabels.json
  12_1_tiny/        ...
  12_2_control/     ...
  12_2_tiny/        ...
```

## Adding more datasets

1. Create a new subfolder under `data/` named after the dataset (e.g. `12_3_treatment`)
2. Add three files with matching base names:
   - `12_3_treatment.csv` — two columns: `t` and `Ct`
   - `12_3_treatment_explanations.json` — AI peak detections + explanations
   - `12_3_treatment_groundtruthlabels.json` — ground truth `[{start, end}, ...]`
3. Add the folder name to `data/manifest.json`

## Deploying to GitHub Pages

**Step 1 — Create a GitHub repository**
- Go to https://github.com/new
- Name it (e.g. `peak-annotator`)
- Set it to Public (required for free GitHub Pages)
- Do NOT initialize with a README (you'll push your own files)

**Step 2 — Push this folder to GitHub**

Open a terminal in the folder containing these files, then run:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
git push -u origin main
```

Replace `YOUR_USERNAME` and `YOUR_REPO_NAME` with your actual GitHub username and repo name.

**Step 3 — Enable GitHub Pages**
- Go to your repo on GitHub
- Click **Settings** → **Pages** (left sidebar)
- Under "Source", select **Deploy from a branch**
- Set Branch to `main`, folder to `/ (root)`
- Click **Save**

**Step 4 — Wait ~2 minutes, then open your site**

Your site will be live at:
```
https://YOUR_USERNAME.github.io/YOUR_REPO_NAME/
```

The app auto-detects the data URL from the page URL, so participants just open that link — no configuration needed.

## Running locally (for testing)

You cannot simply open `index.html` as a `file://` URL because browsers block `fetch()` on local files. Instead, serve it with a local web server:

```bash
# Python 3
python3 -m http.server 8080
# then open http://localhost:8080
```

The data URL field on the welcome screen will auto-populate to `http://localhost:8080/data` and load the datasets from your local `data/` folder.

# Chromatogram Peak Annotator

## Status [1]
In progress. This is an ongoing project to see how analysts change their workload and performance when visualization conditions change. It currently does not have any problems, but conditions may be altered and/or new conditions may be added in future studies using this tool. 

## Introduction 
This is a browser-based annotation tool for chromatogram peaks, used in a human-subjects study comparing AI visualization conditions: manual annotations, AI suggestions for peak locations, peak location suggestions and displayed confidence, peak location suggestions and displayed features, and peak location suggestions, displayed confidence, and displayed features. The conditions are aimed to include increasingly more information to see if cognitive overload appears to affect analysts' experiences (e.g. cognitive load, engagement, accuracy) during annotation.

## Repository structure

```
.github/workflows/
  deploy.yml        ← github workflow for deployment
index.html          ← entry point (loads App.jsx via Babel)
src/
  App.jsx             ← full React app 
  main.jsx            ← React root
package.json          ← required packages
package-lock.json     ← locked packages
vite.config.js        ← vite configuration
public/data/
  manifest.json     ← list of dataset folder names 
  12_1_control/
    12_1_control.csv (chromatogram)
    12_1_control_explanations.json (AI suggestion explanations)
    12_1_control_groundtruthlabels.json (ground truth peak locations)
  12_1_tiny/        ...
  12_2_control/     ...
  12_2_tiny/        ...
```
## Getting Started [2]
### Prerequisites & Needed Materials

This is a web application built with [React / javascript]. To run it you need:

- **Node.js** version v24.12.0  
- **npm** version 11.6.2

All JavaScript dependencies and their exact versions are declared in
[`package.json`](./package.json) (and locked in `package-lock.json`). You do not
install them individually, the package manager will read that file and installs
everything at once (see Installation below).

### Installation
If you are creating a new version of the repositiory, you may follow the steps below. If you wish to alter the website currently depolyed on github pages, simply push your changes after cloning and a workflow will begin to apply your changes to the live website.

1. Make sure Node.js is installed

2. Clone the repository

3. Install all dependencies (reads package.json): npm install

4. Start the app locally: npm run dev      

5. To create a production build for deployment: npm run build

### Usage
There are no commands for running this website. It is deployed on github pages, and a workflow is automatically set up to apply new changes to the website once changes are pushed to github (see deploy.yml for the workflow file). To access the current visualization conditions, use the following links (if deploying on another repo, replace "catac0mb" with your username):

Manual annotation:
```
https://catac0mb.github.io/Peak_Annotator/?condition=no_ai
```
Peak location suggestions only:
```
https://catac0mb.github.io/Peak_Annotator/?condition=peaks_only
```
Peak location suggestions and confidence percentages:
```
https://catac0mb.github.io/Peak_Annotator/?condition=confidence
```
Peak location suggestions and peak features:
```
https://catac0mb.github.io/Peak_Annotator/?condition=bars_only
```
Peak location suggestions, peak features, and confidence percentages:
```
https://catac0mb.github.io/Peak_Annotator/?condition=threshold_bars
```

## Adding more datasets
If you wish to add additional chromatograms with ground truth peak locations and AI suggestions, use the structure below.

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
- Click Settings, then Pages
- Under "Source", select Deploy from a branch
- Set Branch to `main`, folder to `/ (root)`
- Click Save

Your site will be live at:
```
https://YOUR_USERNAME.github.io/YOUR_REPO_NAME/
```

The app auto-detects the data URL from the page URL (provided above), so participants just open that link — no configuration needed.

## Running locally (for testing)

You cannot simply open `index.html` as a `file://` URL because browsers block `fetch()` on local files. Instead, serve it with a local web server:

```bash
# Python 3
python3 -m http.server 8080
# then open http://localhost:8080
```

The data URL field on the welcome screen will auto-populate to `http://localhost:8080/data` and load the datasets from your local `data/` folder.

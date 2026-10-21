# AI Integrated Missing Person Finder Website

## Project Setup

### 1. Prerequisites
- Node.js installed
- Python 3.8+ installed
- Firebase project + Admin service account credentials

### 2. Backend Setup
Navigate to the `backend` folder and install dependencies:
```bash
cd backend
npm install
```
Start the server:
```bash
npm start
```
The backend runs on your deployed Render backend URL.

### 3. AI Service Setup
Navigate to the `ai-service` folder.
Ideally, create a virtual environment first:
```bash
python -m venv venv
# Windows:
venv\Scripts\activate
# Mac/Linux:
source venv/bin/activate
```
Install dependencies:
```bash
pip install -r requirements.txt
```
Run the service:
```bash
python app.py
```
The AI service runs on your deployed Render AI service URL.

### 4. Frontend Usage
Since the frontend uses pure HTML/JS, you can open `frontend/index.html` directly in your browser.
However, for better experience (and preventing CORS issues sometimes), use a simple HTTP server like "Live Server" in VS Code.

## Features Implemented
- **Authentication**: JWT based Login/Register with Roles (Admin, Law Enforcement, Public).
- **Google Sign-In**: Public users can continue with Google; police and organization accounts stay on the manual email/password flow.
- **Reporting**: Upload missing person details + Photo.
- **AI Integration**: Automatically extracts facial embeddings using `DeepFace` (FaceNet model).
- **Auto-Matching**: When a new report is filed, it compares against existing database records and highlights matches > 60% similarity.
- **Dashboard**: View all cases, filter by status.

## Notes
- Images are stored in Firebase Realtime Database as base64 file payloads.
- The AI matching uses a simple cosine similarity check against stored embeddings.
- Google sign-in for public users requires Firebase Web App config values in `frontend/public-google-auth.js` (`apiKey`, `authDomain`, `projectId`, `messagingSenderId`, `appId`).
- The backend accepts Google sign-in only for public-user accounts.

## Production Deployment Guide

### 1. Frontend (Netlify)

This repository is configured for Netlify using `netlify.toml`:
- Publish directory: `frontend`
- Redirect: all routes to `index.html`

If you see **"Site not found"** at `https://missingpersonfinder.netlify.app/`, that usually means the Netlify subdomain is not attached to any active site yet (this is different from an app routing 404).

Checklist:
1. In Netlify, open your site and confirm the site name is exactly `missingpersonfinder`.
2. If the name is different, use the assigned URL from Netlify Site Settings, or rename the site to `missingpersonfinder`.
3. Ensure deploy settings are:
	- Base directory: empty
	- Build command: empty (or `echo "static site"`)
	- Publish directory: `frontend`
4. Trigger a fresh deploy ("Clear cache and deploy site").

### 2. Backend (Render)

Deploy `backend` as a Render Web Service.

Required environment variables:
- `FIREBASE_PROJECT_ID`
- `FIREBASE_DATABASE_URL`
- `FIREBASE_STORAGE_BUCKET`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`
- `JWT_SECRET`
- `AI_SERVICE_URL` (URL of your AI service, no trailing slash)
- `FRONTEND_URL`

After deploy, copy your Render URL (for example `https://missing-person-backend.onrender.com`).

### 3. AI Service (Render or PythonAnywhere)

Option A (Recommended): Render Web Service
- Keeps CORS and networking simple with your backend/frontend.
- Use `ai-service/requirements.txt`.
- Start command should run Flask/Gunicorn app (for example `gunicorn app:app`).

Option B: PythonAnywhere
- Works, but free plans can sleep and have stricter limits.
- Make sure CORS is enabled and endpoint URLs are publicly reachable over HTTPS.

### 4. Frontend API Endpoints

Frontend production URLs are configured in `frontend/app.js`:
- `PROD_BACKEND_ORIGIN`
- `PROD_AI_ORIGIN`

Update these values to your actual deployed URLs before final production rollout.

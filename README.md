# 🎬 VidSave - Facebook & Social Media Video Downloader (Full-Stack)

A modern, production-ready full-stack web application designed for downloading videos from **Facebook**, **TikTok**, **Instagram**, **YouTube**, and other social platforms with zero server disk usage (Direct stdout stream piping).

Inspired by platforms like SaveFrom with enhanced UI, glassmorphism design, and bot bypass protection.

---

## 🌟 Key Features

- **Direct Stream (Zero Disk Writes):** Server streams media chunks directly from `yt-dlp` to the user's browser without saving files locally on the hard disk.
- **Multiple Quality Selections:** Download in HD 1080p, 720p, SD 480p, 360p, or extract MP3 audio directly.
- **Multi-Platform Support:** Works seamlessly with Facebook Videos/Reels, TikTok, Instagram Reels, YouTube, X (Twitter), and Reddit.
- **BotGuard & Anti-Blocking Bypass:** Uses customized user-agent headers, PO token handling, and platform-client impersonation flags in `yt-dlp`.
- **Modern Responsive UI:** Built with React, Vite, Lucide Icons, and Glassmorphism design tokens.
- **SaveFrom Reference Workflow:** 3-step intuitive tutorial and interactive FAQ built-in.
- **Docker Ready:** Full `Dockerfile` and `docker-compose.yml` included.

---

## 🚀 Running Locally

### 1. Prerequisites
- **Node.js** (v18+ or v20+)
- **Python 3.10+**
- **yt-dlp** (`python -m pip install -U yt-dlp`)

### 2. Start the Backend Server
```bash
cd server
npm install
node index.js
```
The backend API will run on `http://localhost:5000`.

### 3. Start the Frontend App
```bash
cd client
npm install
npm run dev
```
Open your browser at `http://localhost:3000`.

---

## 🐳 Running with Docker

To build and launch the complete stack with 1 command:

```bash
docker-compose up --build
```

---

## 🛠️ API Endpoints

- **`GET /api/health`** - Server health & engine status.
- **`GET /api/info?url=<VIDEO_URL>`** - Fetches video metadata, title, thumbnail, duration, and available quality formats.
- **`GET /api/download?url=<VIDEO_URL>&format=<FORMAT>&title=<TITLE>`** - Directly streams the video file with `Content-Disposition: attachment`.

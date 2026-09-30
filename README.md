# AI Meeting Intelligence & Productivity Platform

A full-stack MERN application that turns meeting transcripts into actionable intelligence — summaries, action items, decisions, risks, analytics, and cross-meeting Q&A.

## ✨ Features

**Core**
- Meeting summarization (LLM-powered via Groq, with honest rule-based fallback)
- Action-item tracking — create, edit, delete, drag-and-drop Kanban board
- Audio transcription (Groq Whisper `whisper-large-v3-turbo`)
- Meeting chat — ask questions about a transcript
- RAG-style "Ask Across Meetings" with citations

**Intelligence (honestly labeled)**
- Rule-based extraction: decisions, risks, blockers, open questions, topics
- Rule-based sentiment analysis + heuristic talk-time analytics
- Auto follow-up / promise detection with one-click action-item creation
- Meeting cost calculator, recurring meetings, decision log

**Collaboration & Productivity**
- Real-time collaboration (Socket.io) — live notes & action-item updates
- Workspaces with roles (owner/admin/manager/member), invite links, RBAC, audit log
- In-app notifications + reminder cron job
- Meeting templates, keyboard shortcuts, onboarding tour, landing page

**Platform**
- JWT auth, secure password reset, rate limiting, helmet, CORS allowlist
- Analytics dashboard (trends, completion %, activity timeline)
- PDF/CSV/JSON export, dark/light mode (system auto-detect)
- Email summaries, Google Calendar import, Slack (credential-gated, documented)

## 🛠️ Tech Stack

- **Backend:** Node.js, Express, MongoDB (Mongoose), Socket.io, Groq SDK
- **Frontend:** React 18, Vite, jsPDF, react-toastify, socket.io-client
- **Testing:** 295 unit tests (custom runner, zero dependencies)
- **DevOps:** Docker, docker-compose, GitHub Actions CI

## 📁 Project Structure

```
├── backend/
│   ├── server.js            # Express API (all routes)
│   ├── services/
│   │   ├── llm.js           # LLM provider abstraction (Groq)
│   │   ├── rag.js           # Retrieval (lexical local / OpenAI-Voyage embeddings)
│   │   ├── insights.js      # Sentiment, talk-time, follow-ups, cost, recurrence
│   │   └── realtime.js      # Socket.io collaboration server
│   ├── scripts/
│   │   └── reminders.js     # Deadline reminder cron job
│   └── *.test.js            # Unit tests
├── frontend/
│   └── src/
│       ├── App.jsx          # Full UI (single-component app)
│       ├── App.css
│       └── main.jsx
├── docker-compose.yml
└── DEPLOY.md                # Deployment guide
```

## 🚀 Getting Started

### Prerequisites
- Node.js 18+
- MongoDB (Atlas free tier works)
- Groq API key ([console.groq.com](https://console.groq.com))

### 1. Clone & install
```bash
git clone <your-repo-url>
cd ai-meeting-intelligence-platform/backend && npm install
cd ../frontend && npm install
```

### 2. Configure environment
```bash
cp ../.env.example ../.env   # then fill in values
```
Required in `.env` (place a copy inside `backend/` too, or set env vars directly):
| Variable | Description |
|---|---|
| `JWT_SECRET` | Long random string (required — server refuses to start without it) |
| `MONGO_URI` | MongoDB Atlas connection string |
| `GROQ_API_KEY` | Groq API key (AI summarization, chat, transcription) |

Optional: `SMTP_*` (email), `GOOGLE_CLIENT_ID/SECRET` (calendar), `EMBEDDING_PROVIDER` + key (RAG embeddings), `TOKEN_ENCRYPTION_KEY`.

### 3. Run tests
```bash
cd backend && npm test   # 295 unit tests
```

### 4. Start
```bash
# terminal 1
cd backend && npm start    # http://localhost:5000
# terminal 2
cd frontend && npm run dev # http://localhost:5173
```

### Reminder cron (optional)
```bash
# every hour
0 * * * * cd /path/to/backend && node scripts/reminders.js
```

## 🧪 Testing
- `npm test` — 295 unit tests, 0 failures (pure-logic helpers; no DB needed)
- `integration.test.js` self-skips without local MongoDB + `GROQ_API_KEY`
- See `MANUAL_QA.md` for the manual QA checklist

## 🐳 Docker
```bash
docker compose up --build   # needs root .env
```

## 📝 Honesty notes
- Extraction features (decisions, risks, sentiment, talk-time, follow-ups) are **rule-based/heuristic** and labeled as such in the UI — they are not AI-generated.
- RAG retrieval is **lexical (TF-IDF)** by default; Groq has no embeddings API. Plug in OpenAI/Voyage keys for embedding-based retrieval.
- Email, Google Calendar, and Slack integrations require your own credentials — see `backend/INTEGRATIONS.md`.

## 📄 License
MIT

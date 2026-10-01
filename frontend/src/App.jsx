import { useEffect, useRef, useState } from "react";
import { jsPDF } from "jspdf";
import "./App.css";
import { ToastContainer, toast } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";

// Phase 1 inc-2: local overdue check for action-item deadlines.
// Parses deadline with Date.parse plus DD/MM/YYYY and DD-MM-YYYY support.
// Returns true only if the parsed date is before the start of today AND the
// status is not "Completed"/"Cancelled".
function isOverdueLocal(deadline, status) {
  if (!deadline || typeof deadline !== "string") return false;
  if (status === "Completed" || status === "Cancelled") return false;

  let parsed = Date.parse(deadline);

  // Support DD/MM/YYYY and DD-MM-YYYY formats that Date.parse may reject
  if (Number.isNaN(parsed)) {
    const dm = deadline.trim().match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
    if (dm) {
      const day = String(Number(dm[1])).padStart(2, "0");
      const month = String(Number(dm[2])).padStart(2, "0");
      const year = dm[3];
      parsed = Date.parse(`${year}-${month}-${day}`);
    }
  }

  if (Number.isNaN(parsed)) return false;

  const deadlineDate = new Date(parsed);
  deadlineDate.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return deadlineDate < today;
}

// W3-B: meeting templates for the new-meeting form. Categories must stay
// within the backend enum: General/Project/College/Client/Personal/Urgent.
const MEETING_TEMPLATES = [
  {
    name: "Daily Standup",
    title: "Daily Standup",
    category: "Project",
    tags: ["standup"],
    transcript:
      "Attendees:\n\nYesterday:\n- \n\nToday:\n- \n\nBlockers:\n- ",
  },
  {
    name: "Client Call",
    title: "Client Call",
    category: "Client",
    tags: ["client"],
    transcript:
      "Attendees:\n\nAgenda:\n1. \n\nDiscussion:\n\nNext steps:\n- ",
  },
  {
    name: "Job Interview",
    title: "Job Interview",
    category: "Personal",
    tags: ["interview"],
    transcript:
      "Candidate:\n\nRole:\n\nQuestions asked:\n1. \n\nAssessment:\n\nDecision:\n",
  },
  {
    name: "Sprint Retro",
    title: "Sprint Retro",
    category: "Project",
    tags: ["retro"],
    transcript:
      "What went well:\n- \n\nWhat didn't go well:\n- \n\nAction items:\n- ",
  },
];

// W3-L: onboarding tour steps
const TOUR_STEPS = [
  {
    title: "Welcome! Let's take a quick tour",
    text: "Create a meeting — paste a transcript or upload audio, then generate insights.",
  },
  {
    title: "Track action items",
    text: "Update status, set deadlines, or drag cards on the Kanban board.",
  },
  {
    title: "Ask across meetings",
    text: "RAG-powered Q&A over all your meetings, with citations.",
  },
  {
    title: "Workspaces",
    text: "Collaborate with your team using role-based access.",
  },
];

// W3: extra meeting fields the backend may attach (sentiment, cost inputs,
// recurrence). Missing fields degrade gracefully — never crash.
const meetingExtras = (m, fb) => ({
  sentiment: m?.sentiment ?? fb?.sentiment ?? null,
  hourlyRate: m?.hourlyRate ?? fb?.hourlyRate ?? null,
  participantCount: m?.participantCount ?? fb?.participantCount ?? null,
  recurrence: m?.recurrence ?? fb?.recurrence ?? null,
});

function App() {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("General");
  const [transcript, setTranscript] = useState("");
  const [manualNotes, setManualNotes] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [audioLoading, setAudioLoading] = useState(false);
  const [history, setHistory] = useState([]);
  const [search, setSearch] = useState("");
  const [sortOrder, setSortOrder] = useState("Newest First");
  const [statusFilter, setStatusFilter] = useState("All");
  const [dateFilter, setDateFilter] = useState("All Meetings");
  const [categoryFilter, setCategoryFilter] = useState("All Categories");
  const [tagFilter, setTagFilter] = useState("All Tags");

  // W3-M: auto-detect the OS color scheme on first run; a saved preference
  // always wins. The manual toggle keeps writing to localStorage as before.
  const [darkMode, setDarkMode] = useState(() => {
    const saved = localStorage.getItem("darkMode");
    if (saved !== null) return saved === "true";
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
    );
  });

  const [editId, setEditId] = useState(null);
  const [editMode, setEditMode] = useState(false);
  const [editingActionIndex, setEditingActionIndex] = useState(null);
  const [editTask, setEditTask] = useState("");
  const [editAssignedTo, setEditAssignedTo] = useState("");
  const [editDeadline, setEditDeadline] = useState("");
  const [editPriority, setEditPriority] = useState("Medium");
  // Phase 1 inc-2: "Add Action Item" form state
  const [newTask, setNewTask] = useState("");
  const [newAssignedTo, setNewAssignedTo] = useState("");
  const [newDeadline, setNewDeadline] = useState("");
  const [newPriority, setNewPriority] = useState("Medium");
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  // Phase P1-fix-B2: password reset via hash link `#/reset/<token>`
  const [resetToken, setResetToken] = useState("");
  const [newResetPassword, setNewResetPassword] = useState("");
  const [confirmResetPassword, setConfirmResetPassword] = useState("");
  const [resetSubmitting, setResetSubmitting] = useState(false);

  const [authMode, setAuthMode] = useState("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState([]);
  const [chatLoading, setChatLoading] = useState(false);
  // Phase P11: per-response AI source label for chat ("llm" | "rule-based" | null)
  const [chatAiSource, setChatAiSource] = useState(null);
  // Phase P11: loading state for POST /api/meetings/:id/ai-summary?save=true
  const [aiSummaryLoading, setAiSummaryLoading] = useState(false);

  const [emailDraft, setEmailDraft] = useState("");

  const [token, setToken] = useState(localStorage.getItem("token") || "");
  const [user, setUser] = useState(
    () => JSON.parse(localStorage.getItem("user")) || null
  );

  // Phase P3: analytics dashboard data from /api/meetings/analytics/summary.
  // Stays null when unavailable (offline / API not reached) — dashboard cards
  // fall back to client-side computed values in that case.
  const [analytics, setAnalytics] = useState(null);

  // Phase P4: workspaces & collaboration state
  const [workspaces, setWorkspaces] = useState([]);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [inviteLink, setInviteLink] = useState(null);
  const [shareVisibility, setShareVisibility] = useState("private");
  const [shareWorkspaceId, setShareWorkspaceId] = useState("");

  // Phase P5: notifications & preferences state
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [showNotifications, setShowNotifications] = useState(false);
  const [prefs, setPrefs] = useState(null);
  const [prefsForm, setPrefsForm] = useState({
    emailEnabled: false,
    reminderHoursBefore: 24,
    timezone: "Asia/Kolkata",
  });

  // Phase P6: integrations (Google Calendar/Gmail, Slack) — credential-gated
  // stubs. All status/actions call /api/integrations and surface the backend
  // `note` messages, which explain that live use needs OAuth/SMTP setup.
  const [integStatus, setIntegStatus] = useState(null);
  const [calFrom, setCalFrom] = useState("");
  const [calTo, setCalTo] = useState("");
  const [calResult, setCalResult] = useState(null);
  const [gmailTo, setGmailTo] = useState("");
  const [gmailDraft, setGmailDraft] = useState(null);
  const [slackText, setSlackText] = useState("");
  const [slackResult, setSlackResult] = useState(null);

  // Phase P12: RAG Q&A across meetings. aiSource from the backend is one of
  // "llm" | "rule-based" | "none" — a rule-based answer is lexical-retrieval
  // excerpts and must be labeled as such, never as AI-generated.
  const [ragQuestion, setRagQuestion] = useState("");
  const [ragAnswer, setRagAnswer] = useState(null);
  const [ragCitations, setRagCitations] = useState([]);
  const [ragLoading, setRagLoading] = useState(false);
  const [ragAiSource, setRagAiSource] = useState(null);
  const [ragNote, setRagNote] = useState(null);
  // W3: view navigation (Dashboard / Kanban / Decisions)
  const [view, setView] = useState("main");
  // W3-K: landing vs auth card for logged-out visitors
  const [showAuth, setShowAuth] = useState(false);
  // W3-A: keyboard shortcuts dialog
  const [showShortcuts, setShowShortcuts] = useState(false);
  // W3-L: onboarding tour (shown once until dismissed)
  const [showTour, setShowTour] = useState(
    () => !localStorage.getItem("tourDone")
  );
  const [tourStep, setTourStep] = useState(0);
  // W3-H/I: optional cost + recurrence inputs on the new-meeting form
  const [hourlyRate, setHourlyRate] = useState("");
  const [participantCount, setParticipantCount] = useState("");
  const [recurrenceFrequency, setRecurrenceFrequency] = useState("None");
  const [recurrenceOccurrences, setRecurrenceOccurrences] = useState(1);
  // W3-F/H: per-meeting report (talk time, sentiment, cost) — graceful null
  const [report, setReport] = useState(null);
  // W3-G: rule-based suggested action items for the open meeting
  const [suggestions, setSuggestions] = useState([]);
  // W3-C: kanban board state
  const [kanbanMeetingId, setKanbanMeetingId] = useState("");
  const [dragOverCol, setDragOverCol] = useState(null);
  // W3-D: decision log state
  const [decisionSearch, setDecisionSearch] = useState("");
  const [decisionPage, setDecisionPage] = useState(1);
  const [decisions, setDecisions] = useState([]);
  const [decisionTotal, setDecisionTotal] = useState(0);
  const [decisionLoading, setDecisionLoading] = useState(false);
  // W3-O: email summary dialog state
  const [showEmailDialog, setShowEmailDialog] = useState(false);
  const [emailRecipients, setEmailRecipients] = useState("");
  const [emailSetupHint, setEmailSetupHint] = useState("");
  const [emailSending, setEmailSending] = useState(false);
  // W3-J: realtime collaboration state
  const [liveConnected, setLiveConnected] = useState(false);
  const [collaborators, setCollaborators] = useState(0);
  const socketRef = useRef(null);
  const lastSocketNotesRef = useRef("");
  // W3-P/Q: optional retrieval-method label for Ask Across Meetings
  const [ragRetrievalMethod, setRagRetrievalMethod] = useState(null);

 // Backend base URL: uses Vercel env var in production, localhost in dev
const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:5000";
const API_URL = `${API_BASE}/api/meetings`;
const AUTH_URL = `${API_BASE}/api/auth`;
const WS_URL = `${API_BASE}/api/workspaces`;
const NOTIF_URL = `${API_BASE}/api/notifications`;
const USERS_URL = `${API_BASE}/api/users`;
const INTEG_URL = `${API_BASE}/api/integrations`;


  useEffect(() => {
    if (token) {
      fetchMeetings();
      fetchAnalytics();
      fetchWorkspaces();
      fetchNotifications();
      fetchPreferences();
      fetchIntegStatus();
    }
  }, [token]);

  const toggleDarkMode = () => {
    const newValue = !darkMode;
    setDarkMode(newValue);
    localStorage.setItem("darkMode", newValue);
  };

  useEffect(() => {
    if (darkMode) {
      document.body.classList.add("dark-body");
    } else {
      document.body.classList.remove("dark-body");
    }

    localStorage.setItem("darkMode", darkMode);

    return () => {
      document.body.classList.remove("dark-body");
    };
  }, [darkMode]);

  // W3-A: keyboard shortcuts.
  // Ctrl/Cmd+K focuses the history search, "n" starts a new meeting (only
  // when not typing in a field), Escape closes open dialogs/panels.
  useEffect(() => {
    const onKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        showView("main");
        // Wait a tick so the search input is mounted when switching views
        setTimeout(() => {
          const el = document.getElementById("history-search");
          if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            el.focus();
          }
        }, 50);
        return;
      }

      if (e.key === "Escape") {
        setShowNotifications(false);
        setShowShortcuts(false);
        setShowEmailDialog(false);
        setEditingActionIndex(null);
        return;
      }

      const ae = document.activeElement;
      const typing =
        ae &&
        (ae.tagName === "INPUT" ||
          ae.tagName === "TEXTAREA" ||
          ae.tagName === "SELECT" ||
          ae.isContentEditable);

      if (
        (e.key === "n" || e.key === "N") &&
        !typing &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        token
      ) {
        startNewMeeting();
        showView("main");
        setTimeout(() => {
          const el = document.getElementById("meeting-title-input");
          if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            el.focus();
          }
        }, 50);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [token]);

  // W3-J: realtime collaboration. When a meeting detail is open, connect
  // socket.io (optional dep — skipped silently if not installed), join the
  // meeting room, and apply remote notes / action-item / presence updates.
  useEffect(() => {
    const meetingId = result?._id;
    if (!meetingId || !token) return;

    let cancelled = false;
    let socket = null;

    (async () => {
      const mod = await import("socket.io-client").catch(() => null);
      if (!mod) {
        console.warn(
          "socket.io-client not available — realtime collaboration disabled"
        );
        return;
      }
      if (cancelled) return;

      socket = mod.io(API_BASE, { auth: { token } });

      socketRef.current = socket;

      socket.on("connect", () => {
        if (cancelled) return;
        socket.emit("join-meeting", { meetingId });
        setLiveConnected(true);
      });

      socket.on("disconnect", () => {
        if (!cancelled) setLiveConnected(false);
      });

      socket.on("notes:update", (payload) => {
        if (!payload || payload.meetingId !== meetingId) return;
        lastSocketNotesRef.current = payload.manualNotes ?? "";
        setManualNotes(payload.manualNotes ?? "");
      });

      socket.on("action-item:update", (payload) => {
        if (
          !payload ||
          payload.meetingId !== meetingId ||
          typeof payload.index !== "number" ||
          !payload.item
        )
          return;
        setResult((prev) => {
          if (!prev || prev._id !== meetingId) return prev;
          const items = Array.isArray(prev.actionItems)
            ? [...prev.actionItems]
            : [];
          items[payload.index] = payload.item;
          return { ...prev, actionItems: items };
        });
      });

      socket.on("presence", (payload) => {
        if (!payload || payload.meetingId !== meetingId) return;
        setCollaborators(Number(payload.count) || 0);
      });
    })();

    return () => {
      cancelled = true;
      if (socket) socket.disconnect();
      if (socketRef.current === socket) socketRef.current = null;
      setLiveConnected(false);
      setCollaborators(0);
    };
  }, [result?._id, token]);

  // W3-J: emit local manual-notes edits debounced (~800ms). The ref guards
  // against echoing back notes that arrived from the socket.
  useEffect(() => {
    const meetingId = result?._id;
    const socket = socketRef.current;
    if (!socket || !meetingId || !liveConnected) return;
    if (manualNotes === lastSocketNotesRef.current) return;

    const t = setTimeout(() => {
      socket.emit("notes:update", { meetingId, manualNotes });
      lastSocketNotesRef.current = manualNotes;
    }, 800);

    return () => clearTimeout(t);
  }, [manualNotes, liveConnected, result?._id]);

  // Phase P1-fix-B2: pick up `#/reset/<token>` links (no router in this app,
  // so reset links are hash-based). Listens on mount and on `hashchange`.
  // Phase P4: the same listener also accepts workspace invites via
  // `#/workspaces/accept/<inviteToken>` links.
  useEffect(() => {
    let lastWarnedHash = null;

    const readResetHash = () => {
      const hash = window.location.hash;
      if (!hash.startsWith("#/reset/")) return;

      const tokenFromHash = hash.slice("#/reset/".length).trim();
      if (!tokenFromHash) {
        if (lastWarnedHash !== hash) {
          lastWarnedHash = hash;
          toast.warn("Invalid reset link");
        }
        setResetToken("");
        return;
      }

      setResetToken(tokenFromHash);
    };

    // Phase P4: accept a workspace invite from a
    // `#/workspaces/accept/<inviteToken>` hash link. The hash is cleared
    // immediately (success or failure) so it can never fire twice.
    const acceptWorkspaceInvite = async () => {
      const hash = window.location.hash;
      if (!hash.startsWith("#/workspaces/accept/")) return;

      window.location.hash = "";
      const inviteToken = hash.slice("#/workspaces/accept/".length).trim();
      if (!inviteToken) {
        toast.warn("Invalid invite link");
        return;
      }

      const authToken = localStorage.getItem("token") || "";
      if (!authToken) {
        toast.warn("Please log in to accept the workspace invite");
        return;
      }

      try {
        const response = await fetch(`${WS_URL}/accept/${inviteToken}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
        });

        const data = await response.json();

        if (!response.ok) {
          toast.error(data.message || "Failed to join workspace");
          return;
        }

        toast.success("Joined workspace");
        await fetchWorkspaces();
      } catch (error) {
        toast.error("Failed to accept invite. Please check backend server.");
        console.log("Error accepting workspace invite:", error);
      }
    };

    // Phase P6: the Google OAuth flow redirects back to `#/?google=connected`.
    // Toast, refresh integration status, and clear the hash so it never
    // fires twice.
    const handleGoogleConnectedHash = async () => {
      const hash = window.location.hash;
      if (!hash.includes("google=connected")) return;

      window.location.hash = "";
      toast.success("Google connected");
      await fetchIntegStatus();
    };

    // W3: view navigation via hash (#/main, #/kanban, #/decisions)
    const readViewHash = () => {
      const hash = window.location.hash;
      if (hash === "#/kanban") setView("kanban");
      else if (hash === "#/decisions") setView("decisions");
      else if (hash === "#/main" || hash === "#/dashboard") setView("main");
    };

    const onHashChange = () => {
      readResetHash();
      acceptWorkspaceInvite();
      handleGoogleConnectedHash();
      readViewHash();
    };

    onHashChange();
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const fetchMeetings = async () => {
    try {
      const response = await fetch(API_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      const data = await response.json();

      if (!response.ok) {
        return;
      }

      // Phase 8: backend list endpoint returns either a JSON array (default,
      // transcript excluded) or a paginated object { meetings, page, limit,
      // total, totalPages } when page/limit params are passed.
      const list = Array.isArray(data) ? data : data.meetings || [];
      setHistory(list);
    } catch (error) {
      console.log("Error fetching meetings:", error);
    }
  };

  // Phase P3: fetch analytics summary for the dashboard. On any failure the
  // analytics state stays null (silent — no toast) so the dashboard falls
  // back to client-side computed values and offline behavior is unchanged.
  const fetchAnalytics = async () => {
    try {
      const response = await fetch(`${API_URL}/analytics/summary`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        setAnalytics(null);
        return;
      }

      const data = await response.json();
      setAnalytics(data);
    } catch (error) {
      console.log("Error fetching analytics:", error);
      setAnalytics(null);
    }
  };

  // Phase P4: fetch the user's workspaces. On any failure the list falls back
  // to [] (silent — no toast) so offline behavior is unchanged.
  const fetchWorkspaces = async () => {
    // Read the latest token from localStorage (falling back to state) so the
    // hash-based invite handler always uses a fresh token.
    const authToken = localStorage.getItem("token") || token;
    if (!authToken) {
      setWorkspaces([]);
      return;
    }

    try {
      const response = await fetch(WS_URL, {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });

      if (!response.ok) {
        setWorkspaces([]);
        return;
      }

      const data = await response.json();
      setWorkspaces(Array.isArray(data) ? data : []);
    } catch (error) {
      console.log("Error fetching workspaces:", error);
      setWorkspaces([]);
    }
  };

  // Phase P5: fetch in-app notifications. On any failure the list falls back
  // to [] and unreadCount to 0 (silent — no toast) so offline behavior is
  // unchanged.
  const fetchNotifications = async () => {
    // Read the latest token from localStorage (falling back to state).
    const authToken = localStorage.getItem("token") || token;
    if (!authToken) {
      setNotifications([]);
      setUnreadCount(0);
      return;
    }

    try {
      const response = await fetch(NOTIF_URL, {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });

      if (!response.ok) {
        setNotifications([]);
        setUnreadCount(0);
        return;
      }

      const data = await response.json();
      const list = data.notifications || [];
      setNotifications(list);
      setUnreadCount(
        data.unreadCount ?? list.filter((n) => !n.read).length
      );
    } catch (error) {
      console.log("Error fetching notifications:", error);
      setNotifications([]);
      setUnreadCount(0);
    }
  };

  // Phase P5: fetch notification preferences. On any failure the form keeps
  // its defaults (silent — no toast) so offline behavior is unchanged.
  const fetchPreferences = async () => {
    const authToken = localStorage.getItem("token") || token;
    if (!authToken) return;

    try {
      const response = await fetch(`${USERS_URL}/me/preferences`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });

      if (!response.ok) return;

      const data = await response.json();
      const merged = {
        emailEnabled: data.emailEnabled ?? false,
        reminderHoursBefore: data.reminderHoursBefore ?? 24,
        timezone: data.timezone ?? "Asia/Kolkata",
      };
      setPrefs(merged);
      setPrefsForm(merged);
    } catch (error) {
      console.log("Error fetching preferences:", error);
    }
  };

  // Phase P6: fetch integration connection status. On any failure the
  // status falls back to null (silent — no toast) so offline behavior is
  // unchanged.
  const fetchIntegStatus = async () => {
    // Read the latest token from localStorage (falling back to state) so the
    // hash-based OAuth handler always uses a fresh token.
    const authToken = localStorage.getItem("token") || token;
    if (!authToken) {
      setIntegStatus(null);
      return;
    }

    try {
      const response = await fetch(`${INTEG_URL}/status`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });

      if (!response.ok) {
        setIntegStatus(null);
        return;
      }

      const data = await response.json();
      setIntegStatus(data);
    } catch (error) {
      console.log("Error fetching integration status:", error);
      setIntegStatus(null);
    }
  };

  // ============ W3 feature functions ============

  // W3: switch the visible view (Dashboard / Kanban / Decisions) and keep
  // the hash in sync so it survives refresh.
  const showView = (v) => {
    setView(v);
    const h =
      v === "kanban" ? "#/kanban" : v === "decisions" ? "#/decisions" : "#/main";
    if (window.location.hash !== h) window.location.hash = h;
  };

  // W3-B: prefill the new-meeting form from a template
  const applyTemplate = (t) => {
    setTitle(t.title);
    setCategory(t.category);
    setTagsInput(t.tags.join(", "));
    setTranscript(t.transcript);
    toast.info(`Template applied: ${t.name}`);
  };

  // W3-D: open a meeting's detail view from the decision log / kanban
  const openMeetingById = (meetingId) => {
    if (!meetingId) return;
    showView("main");
    viewMeeting({ _id: meetingId });
  };

  // W3-F/H: fetch the per-meeting report (talk time, sentiment, cost).
  // Stays null when the endpoint is missing — detail widgets degrade.
  const fetchReport = async (meetingId) => {
    if (!meetingId) {
      setReport(null);
      return;
    }
    try {
      const res = await fetch(`${API_URL}/${meetingId}/report`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setReport(null);
        return;
      }
      const data = await res.json();
      setReport(data);
    } catch (e) {
      console.log("Error fetching report:", e);
      setReport(null);
    }
  };

  // W3-G: fetch rule-based suggested action items for a meeting
  const fetchSuggestions = async (meetingId) => {
    if (!meetingId) {
      setSuggestions([]);
      return;
    }
    try {
      const res = await fetch(`${API_URL}/${meetingId}/suggestions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setSuggestions([]);
        return;
      }
      const data = await res.json();
      setSuggestions(Array.isArray(data.suggestions) ? data.suggestions : []);
    } catch (e) {
      console.log("Error fetching suggestions:", e);
      setSuggestions([]);
    }
  };

  // W3-D: fetch the paginated decision log
  const fetchDecisions = async (page = 1, searchText = "") => {
    setDecisionLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "10" });
      if (searchText.trim()) params.set("search", searchText.trim());
      const res = await fetch(`${API_URL}/decisions?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setDecisions([]);
        setDecisionTotal(0);
        return;
      }
      const data = await res.json();
      setDecisions(Array.isArray(data.decisions) ? data.decisions : []);
      setDecisionTotal(data.total ?? 0);
      setDecisionPage(data.page ?? page);
    } catch (e) {
      console.log("Error fetching decisions:", e);
      setDecisions([]);
      setDecisionTotal(0);
    } finally {
      setDecisionLoading(false);
    }
  };

  // W3-D: load the decision log whenever the Decisions view is opened
  useEffect(() => {
    if (view === "decisions" && token) {
      setDecisionPage(1);
      fetchDecisions(1, decisionSearch);
    }
  }, [view]);

  // W3-J: broadcast a local action-item change to collaborators
  const emitActionItemUpdate = (meetingId, index, patch) => {
    if (socketRef.current) {
      socketRef.current.emit("action-item:update", {
        meetingId,
        index,
        patch,
      });
    }
  };

  // W3-C: kanban drop handler — PATCH the new status, then refresh.
  // The Overdue column is computed from deadlines (display-only).
  const handleKanbanDrop = async (e, targetStatus) => {
    e.preventDefault();
    setDragOverCol(null);

    if (targetStatus === "Overdue") {
      toast.info("Overdue is computed from deadlines");
      return;
    }

    let payload = null;
    try {
      payload = JSON.parse(e.dataTransfer.getData("application/json"));
    } catch (err) {
      return;
    }
    if (!payload || typeof payload.index !== "number" || !payload.meetingId)
      return;

    try {
      const res = await fetch(
        `${API_URL}/${payload.meetingId}/action-items/${payload.index}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ status: targetStatus }),
        }
      );
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.message || "Status update failed");
        return;
      }
      toast.success(`Moved to ${targetStatus}`);
      emitActionItemUpdate(payload.meetingId, payload.index, {
        status: targetStatus,
      });
      if (result && result._id === payload.meetingId) {
        setResult((prev) => {
          if (!prev) return prev;
          const items = Array.isArray(prev.actionItems)
            ? [...prev.actionItems]
            : [];
          items[payload.index] = {
            ...items[payload.index],
            status: targetStatus,
          };
          return { ...prev, actionItems: items };
        });
      }
      await fetchMeetings();
    } catch (err) {
      toast.error("Status update failed. Please check backend server.");
      console.log("Error updating kanban status:", err);
    }
  };

  // W3-G: add a suggested action item to the open meeting
  const addSuggestedActionItem = async (text) => {
    if (!result) return;
    try {
      const res = await fetch(`${API_URL}/${result._id}/action-items`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ task: text }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.message || "Failed to add suggestion");
        return;
      }
      setResult({ ...result, actionItems: data.meeting.actionItems });
      setSuggestions((prev) => prev.filter((s) => (s.text ?? s) !== text));
      toast.success("Suggestion added as action item");
      await fetchMeetings();
    } catch (err) {
      toast.error("Failed to add suggestion. Please check backend server.");
      console.log("Error adding suggestion:", err);
    }
  };

  // W3-I: create the next instance of a recurring meeting
  const createNextInstance = async () => {
    if (!result) return;
    try {
      const res = await fetch(`${API_URL}/${result._id}/recur`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.message || "Failed to create next instance");
        return;
      }
      toast.success(
        `Next instance created${
          data.nextDate
            ? ` — ${new Date(data.nextDate).toLocaleDateString()}`
            : ""
        }`
      );
      await fetchMeetings();
    } catch (err) {
      toast.error(
        "Failed to create next instance. Please check backend server."
      );
      console.log("Error creating next instance:", err);
    }
  };

  // W3-O: send the meeting summary to recipient emails (never auto-sends).
  // A 501 means email isn't configured — show the backend's setup hint.
  const sendSummaryEmail = async () => {
    const emails = emailRecipients
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    if (emails.length === 0) {
      toast.warn("Enter at least one recipient email");
      return;
    }
    if (!result) return;

    setEmailSending(true);
    setEmailSetupHint("");
    try {
      const res = await fetch(`${API_URL}/${result._id}/send-summary`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ emails }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.sent) {
        toast.success("Summary sent");
        setShowEmailDialog(false);
        setEmailRecipients("");
      } else if (res.status === 501) {
        setEmailSetupHint(
          data.setup ||
            data.message ||
            "Email sending is not configured on the server."
        );
      } else {
        toast.error(data.message || "Failed to send summary");
      }
    } catch (err) {
      toast.error("Failed to send summary. Please check backend server.");
      console.log("Error sending summary:", err);
    } finally {
      setEmailSending(false);
    }
  };

  // W3-L: dismiss the onboarding tour permanently
  const finishTour = () => {
    localStorage.setItem("tourDone", "1");
    setShowTour(false);
  };

  // Phase P12: ask a question across all meetings (RAG). The backend's
  // aiSource is labeled honestly: "rule-based" means lexical-retrieval
  // excerpts, never AI-generated.
  const askAcrossMeetings = async () => {
    if (!ragQuestion.trim()) {
      toast.warn("Enter a question to ask across your meetings");
      return;
    }

    setRagLoading(true);
    try {
      const response = await fetch(`${API_URL}/ask`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ question: ragQuestion.trim(), topK: 5 }),
      });

      const data = await response.json();

      if (!response.ok) {
        toast.error(data.message || "Failed to get an answer");
        setRagLoading(false);
        return;
      }

      setRagAnswer(data.answer ?? null);
      setRagCitations(
        Array.isArray(data.citations) ? data.citations : []
      );
      setRagAiSource(data.aiSource ?? "none");
      setRagNote(data.note ?? null);
      // W3-P/Q: optional retrieval-method label next to the AI source
      setRagRetrievalMethod(data.retrievalMethod ?? null);
    } catch (error) {
      toast.error("Failed to get an answer. Please check backend server.");
      console.log("Error asking across meetings:", error);
    } finally {
      setRagLoading(false);
    }
  };

  // Phase P6: Google OAuth connect — backend returns the authorize URL, or a
  // 400 with { message } when OAuth is unconfigured. The URL opens in a new
  // tab so the user completes consent there.
  const connectGoogle = async () => {
    try {
      const response = await fetch(`${INTEG_URL}/google/authorize`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      const data = await response.json();

      if (!response.ok) {
        toast.error(data.message || "Google connection unavailable");
        return;
      }

      if (data.url) {
        window.open(data.url, "_blank");
      }
    } catch (error) {
      toast.error("Failed to start Google connection. Please check backend server.");
      console.log(error);
    }
  };

  // Phase P6: disconnect an integration provider ("google" | "slack"), then
  // refresh the connection status.
  const disconnectIntegration = async (provider) => {
    try {
      const response = await fetch(`${INTEG_URL}/${provider}/disconnect`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      const data = await response.json();

      if (!response.ok) {
        toast.error(data.message || `Failed to disconnect ${provider}`);
        return;
      }

      toast.success(
        `${provider === "google" ? "Google" : "Slack"} disconnected`
      );
      await fetchIntegStatus();
    } catch (error) {
      toast.error("Disconnect failed. Please check backend server.");
      console.log(error);
    }
  };

  // Phase P6: import Google Calendar events for a date range. The backend
  // `note` (surfaced below, muted) explains stub/credential-gated behavior.
  const importCalendar = async () => {
    if (!calFrom || !calTo) {
      toast.warn("Select both a from and a to date");
      return;
    }

    try {
      const response = await fetch(`${INTEG_URL}/google/calendar/import`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ from: calFrom, to: calTo }),
      });

      const data = await response.json();

      if (!response.ok) {
        toast.error(data.message || "Calendar import failed");
        return;
      }

      setCalResult(data);
      toast.success(
        `Calendar import finished: ${data.imported ?? 0} imported`
      );
    } catch (error) {
      toast.error("Calendar import failed. Please check backend server.");
      console.log(error);
    }
  };

  // Phase P6: build (never send) a Gmail draft for the currently open
  // meeting. The backend returns { draft: { to, subject, body } } only.
  const buildGmailDraft = async () => {
    if (!result) return;

    if (!gmailTo.trim()) {
      toast.warn("Enter a recipient email");
      return;
    }

    try {
      const response = await fetch(`${INTEG_URL}/google/gmail/draft`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ meetingId: result._id, to: gmailTo.trim() }),
      });

      const data = await response.json();

      if (!response.ok) {
        toast.error(data.message || "Failed to build Gmail draft");
        return;
      }

      setGmailDraft(data);
      toast.success("Gmail draft built (nothing sent)");
    } catch (error) {
      toast.error("Failed to build draft. Please check backend server.");
      console.log(error);
    }
  };

  // Phase P6: send a test Slack message. Credential-gated stub — the backend
  // returns { posted, note } and the note is shown muted below.
  const sendSlackTest = async () => {
    if (!slackText.trim()) {
      toast.warn("Enter a message to send");
      return;
    }

    try {
      const response = await fetch(`${INTEG_URL}/slack/notify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ text: slackText.trim() }),
      });

      const data = await response.json();

      if (!response.ok) {
        toast.error(data.message || "Slack test failed");
        return;
      }

      setSlackResult(data);
      toast.info(data.note || "Slack test finished");
    } catch (error) {
      toast.error("Slack test failed. Please check backend server.");
      console.log(error);
    }
  };

  // Phase P5: mark a single notification as read (optimistic decrement, then
  // refresh the list so the server count wins).
  const markNotificationRead = async (id) => {
    try {
      const response = await fetch(`${NOTIF_URL}/${id}/read`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) return;

      setNotifications((prev) =>
        prev.map((n) => (n._id === id ? { ...n, read: true } : n))
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));
      await fetchNotifications();
    } catch (error) {
      console.log("Error marking notification as read:", error);
    }
  };

  // Phase P5: mark all notifications as read
  const markAllNotificationsRead = async () => {
    try {
      const response = await fetch(`${NOTIF_URL}/read-all`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        toast.error(data.message || "Failed to mark all as read");
        return;
      }

      await fetchNotifications();
      toast.success("All notifications marked as read");
    } catch (error) {
      toast.error("Failed to mark all as read. Please check backend server.");
      console.log("Error marking all notifications as read:", error);
    }
  };

  // Phase P5: save notification preferences
  const savePreferences = async (e) => {
    if (e) e.preventDefault();

    try {
      const response = await fetch(`${USERS_URL}/me/preferences`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          emailEnabled: prefsForm.emailEnabled,
          reminderHoursBefore: Number(prefsForm.reminderHoursBefore),
          timezone: prefsForm.timezone,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        toast.error(data.message || "Failed to save preferences");
        return;
      }

      setPrefs(data.preferences || data);
      toast.success("Notification preferences saved");
    } catch (error) {
      toast.error("Failed to save preferences. Please check backend server.");
      console.log(error);
    }
  };

  // Phase P4: create a workspace and refresh the list
  const createWorkspace = async () => {
    if (!newWorkspaceName.trim()) {
      toast.warn("Workspace name is required");
      return;
    }

    try {
      const response = await fetch(WS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: newWorkspaceName.trim() }),
      });

      const data = await response.json();

      if (!response.ok) {
        toast.error(data.message || "Failed to create workspace");
        return;
      }

      setNewWorkspaceName("");
      setInviteLink(null);
      toast.success("Workspace created");
      await fetchWorkspaces();
    } catch (error) {
      toast.error("Failed to create workspace. Please check backend server.");
      console.log(error);
    }
  };

  // Phase P4: generate an invite link for a workspace (owner/admin only)
  const createInviteLink = async (workspaceId) => {
    try {
      const response = await fetch(`${WS_URL}/${workspaceId}/invite`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      const data = await response.json();

      if (!response.ok) {
        toast.error(data.message || "Failed to create invite link");
        return;
      }

      setInviteLink(data.inviteUrl);
      toast.success("Invite link created");
    } catch (error) {
      toast.error("Failed to create invite link. Please check backend server.");
      console.log(error);
    }
  };

  // Phase P4: copy the generated invite link to the clipboard
  const copyInviteLink = async () => {
    if (!inviteLink) return;

    try {
      await navigator.clipboard.writeText(inviteLink);
      toast.success("Invite link copied to clipboard!");
    } catch (error) {
      toast.error("Failed to copy invite link");
      console.log(error);
    }
  };

  // Phase P4: save meeting visibility (private / shared with a workspace).
  // Meeting owner only, enforced by the backend.
  const saveSharing = async () => {
    if (!result) return;

    if (shareVisibility === "workspace" && !shareWorkspaceId) {
      toast.warn("Select a workspace to share with");
      return;
    }

    try {
      const response = await fetch(`${API_URL}/${result._id}/share`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          visibility: shareVisibility,
          workspaceId: shareWorkspaceId || undefined,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        toast.error(data.message || "Failed to save sharing settings");
        return;
      }

      const updated = data.meeting || {};
      setResult({
        ...result,
        visibility: updated.visibility,
        workspace: updated.workspace,
      });
      toast.success("Sharing settings saved");
      await fetchMeetings();
    } catch (error) {
      toast.error("Failed to save sharing settings. Please check backend server.");
      console.log(error);
    }
  };

  const handleAuth = async (e) => {
    if (e) e.preventDefault();
    try {
      const endpoint = authMode === "login" ? "login" : "register";

      const bodyData =
        authMode === "login"
          ? { email: email.trim(), password }
          : { name: name.trim(), email: email.trim(), password };

      const response = await fetch(`${AUTH_URL}/${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(bodyData),
      });

      const data = await response.json();

      if (!response.ok) {
        toast.error(data.message || "Authentication failed");
        return;
      }

      if (authMode === "register") {
        toast.success("Registration successful. Now login.");
        setAuthMode("login");
        setName("");
        setEmail("");
        setPassword("");
        return;
      }

      localStorage.setItem("token", data.token);
      localStorage.setItem("user", JSON.stringify(data.user));

      setToken(data.token);
      setUser(data.user);
      toast.success("Login successful!");

      setEmail("");
      setPassword("");
      setName("");
    } catch (error) {
      toast.error("Login/Register failed. Check backend.");
      console.log(error);
    }
  };

  const handleForgotPassword = async (e) => {
    e.preventDefault();
    try {
      const response = await fetch(`${AUTH_URL}/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: forgotEmail }),
      });
      const data = await response.json();
      if (response.ok) {
        toast.success(data.message);
        setShowForgotPassword(false);
      } else {
        toast.error(data.message || "Something went wrong");
      }
    } catch (error) {
      toast.error("Server error");
    }
  };

  const handleResetPassword = async (e) => {
    e.preventDefault();

    if (!newResetPassword || !confirmResetPassword) {
      toast.warn("Please fill in both password fields");
      return;
    }
    if (newResetPassword.length < 6) {
      toast.warn("Password must be at least 6 characters");
      return;
    }
    if (newResetPassword !== confirmResetPassword) {
      toast.warn("Passwords do not match");
      return;
    }

    setResetSubmitting(true);
    try {
      const response = await fetch(
        `${AUTH_URL}/reset-password/${resetToken}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ newPassword: newResetPassword }),
        }
      );
      const data = await response.json();
      if (response.ok) {
        toast.success(data.message || "Password updated successfully!");
        window.location.hash = "";
        setResetToken("");
        setNewResetPassword("");
        setConfirmResetPassword("");
      } else {
        toast.error(data.message || "Something went wrong");
      }
    } catch (error) {
      toast.error("Server error");
    } finally {
      setResetSubmitting(false);
    }
  };

  const logout = () => {
    const confirmLogout = window.confirm("Are you sure you want to logout?");

    if (!confirmLogout) {
      return;
    }

    localStorage.removeItem("token");
    localStorage.removeItem("user");

    setToken("");
    setUser(null);
    setHistory([]);
    setAnalytics(null);
    // Phase P4: clear workspace & sharing state on logout
    setWorkspaces([]);
    setNewWorkspaceName("");
    setInviteLink(null);
    setShareVisibility("private");
    setShareWorkspaceId("");
    // Phase P5: clear notification & preference state on logout
    setNotifications([]);
    setUnreadCount(0);
    setShowNotifications(false);
    setPrefs(null);
    setPrefsForm({
      emailEnabled: false,
      reminderHoursBefore: 24,
      timezone: "Asia/Kolkata",
    });
    // Phase P6: clear integrations state on logout
    setIntegStatus(null);
    setCalFrom("");
    setCalTo("");
    setCalResult(null);
    setGmailTo("");
    setGmailDraft(null);
    setSlackText("");
    setSlackResult(null);
    // Phase P12: clear RAG Q&A state on logout
    setRagQuestion("");
    setRagAnswer(null);
    setRagCitations([]);
    setRagLoading(false);
    setRagAiSource(null);
    setRagNote(null);
    setRagRetrievalMethod(null);
    // W3: clear worker-3 feature state on logout
    setView("main");
    setShowShortcuts(false);
    setShowEmailDialog(false);
    setEmailRecipients("");
    setEmailSetupHint("");
    setHourlyRate("");
    setParticipantCount("");
    setRecurrenceFrequency("None");
    setRecurrenceOccurrences(1);
    setReport(null);
    setSuggestions([]);
    setKanbanMeetingId("");
    setDecisionSearch("");
    setDecisionPage(1);
    setDecisions([]);
    setDecisionTotal(0);
    setResult(null);
    setTitle("");
    setCategory("General");
    setTranscript("");
    setManualNotes("");
    setTagsInput("");
    setSearch("");
    setSortOrder("Newest First");
    setStatusFilter("All");
    setDateFilter("All Meetings");
    setCategoryFilter("All Categories");
    setTagFilter("All Tags");
    setEditId(null);
    setEditMode(false);
    setEmailDraft("");
  };

  const uploadAudio = async (e) => {
    const file = e.target.files[0];

    if (!file) {
      return;
    }

    if (file.size > 25 * 1024 * 1024) {
      toast.warn("File too large (max 25MB)");
      return;
    }

    const formData = new FormData();
    formData.append("audio", file);

    try {
      setAudioLoading(true);

      const response = await fetch(`${API_URL}/transcribe-audio`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
      });

      const data = await response.json();

      if (response.ok && data.transcript) {
        setTranscript(data.transcript);
        toast.success("Audio converted to transcript successfully");
      } else {
        toast.error(data.message || "Audio transcription failed");
      }
    } catch (error) {
      toast.error("Audio upload failed. Please try again.");
      console.log(error);
    } finally {
      setAudioLoading(false);
    }
  };

  const generateSummary = async () => {
    if (!transcript.trim() && !manualNotes.trim()) {
      toast.warn("Please enter meeting transcript or manual notes");
      return;
    }

    try {
      setLoading(true);
      const parsedTags = tagsInput
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0);

      const response = await fetch(`${API_URL}/summarize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          title: title || "Untitled Meeting",
          category,
          transcript,
          manualNotes,
          tags: parsedTags,
          // W3-H/I: optional cost + recurrence inputs
          ...(hourlyRate !== "" && !Number.isNaN(Number(hourlyRate))
            ? { hourlyRate: Number(hourlyRate) }
            : {}),
          ...(participantCount !== "" &&
          !Number.isNaN(Number(participantCount))
            ? { participantCount: Number(participantCount) }
            : {}),
          ...(recurrenceFrequency !== "None"
            ? {
                recurrence: {
                  frequency: recurrenceFrequency,
                  occurrences: Number(recurrenceOccurrences) || 1,
                },
              }
            : {}),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        toast.error(data.message || "Something went wrong");
        return;
      }

      setResult({
        _id: data._id,
        category: data.category || "General",
        tags: data.tags || [],
        summary: data.summary,
        keyPoints: data.keyPoints,
        speakerNotes: data.speakerNotes || [],
        actionItems: data.actionItems,
        decisions: data.decisions || [],
        risks: data.risks || [],
        blockers: data.blockers || [],
        openQuestions: data.openQuestions || [],
        importantTopics: data.importantTopics || [],
        extractionMethod: data.extractionMethod || "rule-based",
        ...meetingExtras(data, null),
      });

      setCategory(data.category || "General");
      setEditId(data._id);
      setEditMode(true);
      // Phase P4: a newly generated meeting starts private
      setShareVisibility("private");
      setShareWorkspaceId("");
      toast.success("Summary & intelligence generated successfully!");

      // W3: load the per-meeting report + suggestions for the detail view
      fetchReport(data._id);
      fetchSuggestions(data._id);
      await fetchMeetings();
    } catch (error) {
      toast.error("Something went wrong. Please check backend server.");
      console.log(error);
    } finally {
      setLoading(false);
    }
  };

  const updateMeeting = async () => {
    if (!editId) {
      toast.warn("No meeting selected for update");
      return;
    }

    const confirmUpdate = window.confirm(
      "Are you sure you want to update this meeting?"
    );

    if (!confirmUpdate) {
      return;
    }

    try {
      setLoading(true);
      const parsedTags = tagsInput
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0);

      const response = await fetch(`${API_URL}/${editId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          title: title || "Untitled Meeting",
          category,
          transcript,
          manualNotes,
          tags: parsedTags,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        toast.error(data.message || "Update failed");
        return;
      }

      setResult({
        _id: data.meeting._id,
        category: data.meeting.category || "General",
        tags: data.meeting.tags || [],
        summary: data.meeting.summary,
        keyPoints: data.meeting.keyPoints,
        speakerNotes: data.meeting.speakerNotes || [],
        actionItems: data.meeting.actionItems,
        decisions: data.meeting.decisions || [],
        risks: data.meeting.risks || [],
        blockers: data.meeting.blockers || [],
        openQuestions: data.meeting.openQuestions || [],
        importantTopics: data.meeting.importantTopics || [],
        extractionMethod: data.meeting.extractionMethod || "rule-based",
        ...meetingExtras(data.meeting, result),
      });

      setCategory(data.meeting.category || "General");
      setEditId(data.meeting._id);
      setEditMode(true);

      fetchReport(data.meeting._id);
      fetchSuggestions(data.meeting._id);
      await fetchMeetings();
      toast.success("Meeting updated successfully");
    } catch (error) {
      toast.error("Update failed. Please check backend server.");
      console.log(error);
    } finally {
      setLoading(false);
    }
  };

  const clearAll = (showConfirm = true) => {
    if (showConfirm) {
      const confirmClear = window.confirm(
        "Are you sure you want to clear current meeting data?"
      );

      if (!confirmClear) {
        return;
      }
    }

    setTitle("");
    setCategory("General");
    setTranscript("");
    setManualNotes("");
    setTagsInput("");
    setResult(null);
    setStatusFilter("All");
    setEditId(null);
    setEditMode(false);
    setEmailDraft("");
    // W3: reset cost/recurrence/report/suggestion state
    setHourlyRate("");
    setParticipantCount("");
    setRecurrenceFrequency("None");
    setRecurrenceOccurrences(1);
    setReport(null);
    setSuggestions([]);
  };

  const startNewMeeting = () => {
    setTitle("");
    setCategory("General");
    setTranscript("");
    setManualNotes("");
    setTagsInput("");
    setResult(null);
    setStatusFilter("All");
    setEditId(null);
    setEditMode(false);
    setEmailDraft("");
    // Phase P11: a new meeting resets the chat source label
    setChatAiSource(null);
    // W3: reset cost/recurrence/report/suggestion state
    setHourlyRate("");
    setParticipantCount("");
    setRecurrenceFrequency("None");
    setRecurrenceOccurrences(1);
    setReport(null);
    setSuggestions([]);
  };

  const deleteMeeting = async (id) => {
    const confirmDelete = window.confirm(
      "Are you sure you want to delete this meeting?"
    );

    if (!confirmDelete) {
      return;
    }

    try {
      const response = await fetch(`${API_URL}/${id}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      const data = await response.json();

      if (!response.ok) {
        toast.error(data.message || "Delete failed");
        return;
      }

      if (editId === id) {
        clearAll(false);
      }

      await fetchMeetings();
      toast.success("Meeting deleted successfully");
    } catch (error) {
      toast.error("Delete failed. Please check backend server.");
      console.log("Error deleting meeting:", error);
    }
  };

  const updateActionStatus = async (meetingId, actionIndex, newStatus) => {
    try {
      const response = await fetch(
        `${API_URL}/${meetingId}/action-items/${actionIndex}/status`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            status: newStatus,
          }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        toast.error(data.message || "Status update failed");
        return;
      }

      setResult({
        _id: data.meeting._id,
        category: data.meeting.category || "General",
        tags: data.meeting.tags || [],
        summary: data.meeting.summary,
        keyPoints: data.meeting.keyPoints,
        speakerNotes: data.meeting.speakerNotes || [],
        actionItems: data.meeting.actionItems,
        decisions: data.meeting.decisions || [],
        risks: data.meeting.risks || [],
        blockers: data.meeting.blockers || [],
        openQuestions: data.meeting.openQuestions || [],
        importantTopics: data.meeting.importantTopics || [],
        extractionMethod: data.meeting.extractionMethod || "rule-based",
        ...meetingExtras(data.meeting, result),
      });

      setCategory(data.meeting.category || "General");

      // W3-J: broadcast the status change to collaborators in realtime
      emitActionItemUpdate(meetingId, actionIndex, { status: newStatus });
      await fetchMeetings();
    } catch (error) {
      console.log("Error updating status:", error);
    }
  };

  // Phase 1: action-item edit now persists to MongoDB via PATCH API
  // (previously this only updated React state and was lost on refresh)
  const saveEditedActionItem = async () => {
    if (!result || editingActionIndex === null) return;

    try {
      const response = await fetch(
        `${API_URL}/${result._id}/action-items/${editingActionIndex}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            task: editTask,
            assignedTo: editAssignedTo,
            deadline: editDeadline,
            priority: editPriority,
          }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        toast.error(data.message || "Update failed");
        return;
      }

      setResult({ ...result, actionItems: data.meeting.actionItems });
      setEditingActionIndex(null);
      toast.success("Action item updated");
      await fetchMeetings();
    } catch (error) {
      toast.error("Update failed. Please check backend server.");
      console.log(error);
    }
  };

  // Phase 1: delete an action item (with confirmation), persisted to MongoDB
  const deleteActionItem = async (index) => {
    if (!result) return;

    const confirmDelete = window.confirm(
      "Are you sure you want to delete this action item?"
    );
    if (!confirmDelete) return;

    try {
      const response = await fetch(
        `${API_URL}/${result._id}/action-items/${index}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      const data = await response.json();

      if (!response.ok) {
        toast.error(data.message || "Delete failed");
        return;
      }

      setResult({ ...result, actionItems: data.meeting.actionItems });
      toast.success("Action item deleted");
      await fetchMeetings();
    } catch (error) {
      toast.error("Delete failed. Please check backend server.");
      console.log(error);
    }
  };

  // Phase 1 inc-2: add a new action item, persisted to MongoDB via POST API
  const addActionItem = async (e) => {
    if (e) e.preventDefault();
    if (!result) return;

    if (!newTask.trim()) {
      toast.warn("Task is required");
      return;
    }

    try {
      const response = await fetch(`${API_URL}/${result._id}/action-items`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          task: newTask.trim(),
          assignedTo: newAssignedTo.trim(),
          deadline: newDeadline.trim(),
          priority: newPriority,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        const msg = data.message || "Failed to add action item";
        if (data.errors && data.errors.length > 0) {
          toast.error(`${msg}: ${data.errors.join(", ")}`);
        } else {
          toast.error(msg);
        }
        return;
      }

      setResult({ ...result, actionItems: data.meeting.actionItems });
      setNewTask("");
      setNewAssignedTo("");
      setNewDeadline("");
      setNewPriority("Medium");
      toast.success(data.message || "Action item added");
      await fetchMeetings();
    } catch (error) {
      toast.error("Failed to add action item. Please check backend server.");
      console.log(error);
    }
  };

  const viewMeeting = async (meeting) => {
    // Phase 8: the list endpoint excludes the transcript by default, so fetch
    // the full meeting (including transcript) via the detail endpoint. On any
    // failure, fall back to the list object passed in so viewing never breaks.
    let full = meeting;
    try {
      const res = await fetch(`${API_URL}/${meeting._id}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (res.ok) {
        full = await res.json();
      }
    } catch (err) {
      console.log("Error fetching full meeting:", err);
    }

    setTitle(full.title);
    setCategory(full.category || "General");
    setTranscript(full.transcript || "");
    setManualNotes(full.manualNotes || "");
    setTagsInput(full.tags ? full.tags.join(", ") : "");
    setStatusFilter("All");
    setEditId(full._id);
    setEditMode(true);

    setResult({
      _id: full._id,
      category: full.category || "General",
      tags: full.tags || [],
      summary: full.summary,
      keyPoints: full.keyPoints,
      speakerNotes: full.speakerNotes || [],
      actionItems: full.actionItems,
      decisions: full.decisions || [],
      risks: full.risks || [],
      blockers: full.blockers || [],
      openQuestions: full.openQuestions || [],
      importantTopics: full.importantTopics || [],
      extractionMethod: full.extractionMethod || "rule-based",
      ...meetingExtras(full, null),
    });

    // Phase P4: initialize sharing controls from the loaded meeting
    setShareVisibility(full.visibility === "workspace" ? "workspace" : "private");
    setShareWorkspaceId(full.workspace ? String(full.workspace) : "");

    setEmailDraft("");
    // Phase P11: opening a different meeting resets the chat source label
    setChatAiSource(null);
    // W3: load the per-meeting report (talk time / sentiment / cost) and
    // rule-based suggested action items for the detail view
    fetchReport(full._id);
    fetchSuggestions(full._id);
    window.scrollTo({
      top: 0,
      behavior: "smooth",
    });
  };

  const startEditActionItem = (item, index) => {
    setEditingActionIndex(index);
    setEditTask(item.task);
    setEditAssignedTo(item.assignedTo);
    setEditDeadline(item.deadline);
    setEditPriority(item.priority);
  };

  const generateEmailDraft = () => {
    if (!result) return;

    let draft = `Hi Team,\n\nHere is a quick recap and summary of our meeting: "${title || "Untitled Meeting"}"\n\n`;
    draft += `Summary:\n${result.summary}\n\n`;

    if (result.decisions && result.decisions.length > 0) {
      draft += `Key Decisions:\n`;
      result.decisions.forEach((d) => (draft += `- ${d}\n`));
      draft += `\n`;
    }

    if (result.actionItems && result.actionItems.length > 0) {
      draft += `Action Items:\n`;
      result.actionItems.forEach((item, index) => {
        draft += `${index + 1}. ${item.task} (Assigned to: ${item.assignedTo || "Unassigned"}, Deadline: ${item.deadline || "TBD"})\n`;
      });
      draft += `\n`;
    }

    draft += `Please let me know if I missed anything.\n\nBest regards,\n${user?.name || "Participant"}`;
    setEmailDraft(draft);
  };

  const copyEmailDraft = async () => {
    try {
      await navigator.clipboard.writeText(emailDraft);
      toast.success("Email draft copied to clipboard!");
    } catch (err) {
      toast.error("Failed to copy email draft.");
    }
  };

  const downloadReport = () => {
    if (!result) {
      toast.warn("No report available to download");
      return;
    }

    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();

    let y = 32; // W3-N: shifted down to leave room for the branded header

    const addFooter = () => {
      doc.setFontSize(9);
      doc.text(
        "Generated by Meeting Summarizer & Intelligence Hub",
        15,
        pageHeight - 10
      );
    };

    const checkPageSpace = (neededSpace = 20) => {
      if (y + neededSpace > pageHeight - 20) {
        addFooter();
        doc.addPage();
        y = 32; // W3-N: keep clear of the branded header
      }
    };

    doc.setFontSize(20);
    doc.text("Meeting Intelligence Report", pageWidth / 2, y, {
      align: "center",
    });

    y += 12;

    doc.setFontSize(11);
    doc.text(`Meeting Title: ${title || "Untitled Meeting"}`, 15, y);
    y += 8;

    doc.text(`Category: ${category || "General"}`, 15, y);
    y += 8;

    doc.text(`Tags: ${result.tags ? result.tags.join(", ") : "None"}`, 15, y);
    y += 8;

    doc.text(`Date & Time: ${new Date().toLocaleString()}`, 15, y);
    y += 12;

    doc.line(15, y, pageWidth - 15, y);
    y += 12;

    doc.setFontSize(15);
    doc.text("1. Summary", 15, y);
    y += 8;

    doc.setFontSize(11);
    const summaryLines = doc.splitTextToSize(result.summary, 180);
    checkPageSpace(summaryLines.length * 7);
    doc.text(summaryLines, 15, y);
    y += summaryLines.length * 7 + 8;

    const sections = [
      { title: "Key Decisions", data: result.decisions },
      { title: "Risks", data: result.risks },
      { title: "Blockers", data: result.blockers },
      { title: "Open Questions", data: result.openQuestions },
      { title: "Important Topics", data: result.importantTopics },
    ];

    sections.forEach((sec, sIdx) => {
      if (sec.data && sec.data.length > 0) {
        checkPageSpace(20);
        doc.setFontSize(14);
        doc.text(`${2 + sIdx}. ${sec.title}`, 15, y);
        y += 8;
        doc.setFontSize(10);
        sec.data.forEach((item) => {
          const lines = doc.splitTextToSize(`- ${item}`, 180);
          checkPageSpace(lines.length * 6);
          doc.text(lines, 15, y);
          y += lines.length * 6;
        });
        y += 4;
      }
    });

    addFooter();

    // W3-N: branded header on every page — product name, meeting title,
    // export date.
    const exportDateStr = new Date().toLocaleString();
    for (let p = 1; p <= doc.getNumberOfPages(); p++) {
      doc.setPage(p);
      doc.setFontSize(9);
      doc.setTextColor(100);
      doc.text("AI Meeting Intelligence Platform", 10, 10);
      doc.text(title || "Untitled Meeting", pageWidth - 10, 10, {
        align: "right",
      });
      doc.text(`Exported: ${exportDateStr}`, 10, 16);
      doc.setTextColor(0);
    }

    doc.save("professional-meeting-report.pdf");
  };

  const printReport = () => {
    if (!result) {
      toast.warn("No report available to print");
      return;
    }

    window.print();
  };

  const downloadTXT = () => {
    if (!result) {
      toast.warn("No data available to download");
      return;
    }

    let content = "";

    content += `Meeting Title: ${title || "Untitled Meeting"}\n`;
    content += `Category: ${category || "General"}\n`;
    content += `Tags: ${result.tags ? result.tags.join(", ") : "None"}\n`;
    content += `Date & Time: ${new Date().toLocaleString()}\n\n`;

    content += `Summary:\n${result.summary}\n\n`;

    content += "Key Points:\n";
    result.keyPoints.forEach((point, index) => {
      content += `${index + 1}. ${point}\n`;
    });

    if (result.decisions && result.decisions.length > 0) {
      content += "\nDecisions:\n";
      result.decisions.forEach((d) => (content += `- ${d}\n`));
    }

    content += "\nAction Items:\n";
    result.actionItems.forEach((item, index) => {
      content += `${index + 1}. Task: ${item.task}\n`;
      content += `Assigned To: ${item.assignedTo}\n`;
      content += `Deadline: ${item.deadline}\n`;
      content += `Priority: ${item.priority}\n`;
      content += `Status: ${item.status || "Pending"}\n\n`;
    });

    content += `Transcript:\n${transcript}`;

    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = "meeting-summary.txt";
    link.click();

    URL.revokeObjectURL(url);
  };

  const downloadJSON = () => {
    if (!result) {
      toast.warn("No data available to download");
      return;
    }

    const data = {
      title: title || "Untitled Meeting",
      category: category || "General",
      tags: result.tags || [],
      date: new Date().toLocaleString(),
      transcript,
      manualNotes,
      summary: result.summary,
      keyPoints: result.keyPoints,
      decisions: result.decisions,
      risks: result.risks,
      blockers: result.blockers,
      openQuestions: result.openQuestions,
      importantTopics: result.importantTopics,
      actionItems: result.actionItems,
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });

    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = "meeting-summary.json";
    link.click();

    URL.revokeObjectURL(url);
  };

  const downloadCSV = () => {
    if (!result) {
      toast.warn("No data available to download");
      return;
    }

    let csv = "Task,Assigned To,Deadline,Priority,Status\n";

    result.actionItems.forEach((item) => {
      csv += `"${item.task}","${item.assignedTo}","${item.deadline}","${
        item.priority
      }","${item.status || "Pending"}"\n`;
    });

    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = "action-items.csv";
    link.click();

    URL.revokeObjectURL(url);
  };

  const copySummary = async () => {
    if (!result) {
      toast.warn("No summary available to copy");
      return;
    }

    try {
      await navigator.clipboard.writeText(result.summary);
      toast.success("Summary copied successfully");
    } catch (error) {
      toast.error("Failed to copy summary");
      console.log(error);
    }
  };

  const isWithinDateFilter = (meetingDate) => {
    const meeting = new Date(meetingDate);
    const today = new Date();

    if (dateFilter === "All Meetings") {
      return true;
    }

    if (dateFilter === "Today") {
      return (
        meeting.getDate() === today.getDate() &&
        meeting.getMonth() === today.getMonth() &&
        meeting.getFullYear() === today.getFullYear()
      );
    }

    if (dateFilter === "This Week") {
      const startOfWeek = new Date(today);
      startOfWeek.setDate(today.getDate() - today.getDay());
      startOfWeek.setHours(0, 0, 0, 0);

      const endOfWeek = new Date(startOfWeek);
      endOfWeek.setDate(startOfWeek.getDate() + 6);
      endOfWeek.setHours(23, 59, 59, 999);

      return meeting >= startOfWeek && meeting <= endOfWeek;
    }

    if (dateFilter === "This Month") {
      return (
        meeting.getMonth() === today.getMonth() &&
        meeting.getFullYear() === today.getFullYear()
      );
    }

    return true;
  };

  const totalMeetings = history.length;

  const totalActionItems = history.reduce((total, meeting) => {
    return total + (meeting.actionItems ? meeting.actionItems.length : 0);
  }, 0);

  const pendingTasks = history.reduce((total, meeting) => {
    const pending = meeting.actionItems
      ? meeting.actionItems.filter((item) => item.status !== "Completed").length
      : 0;

    return total + pending;
  }, 0);

  const completedTasks = history.reduce((total, meeting) => {
    const completed = meeting.actionItems
      ? meeting.actionItems.filter((item) => item.status === "Completed").length
      : 0;

    return total + completed;
  }, 0);

  const highPriorityTasks = history.reduce((total, meeting) => {
    const high = meeting.actionItems
      ? meeting.actionItems.filter((item) => item.priority === "High").length
      : 0;

    return total + high;
  }, 0);

  const completionPercentage =
    totalActionItems > 0
      ? Math.round((completedTasks / totalActionItems) * 100)
      : 0;

  const categoryBreakdown = history.reduce((acc, meeting) => {
    const cat = meeting.category || "General";
    acc[cat] = (acc[cat] || 0) + 1;
    return acc;
  }, {});

  // Phase P3: API-backed analytics values with client-side fallbacks so the
  // dashboard still works offline / when the analytics endpoint is down.
  const displayCompletionPct = analytics?.completionPct ?? completionPercentage;
  const displayCategoryEntries = analytics?.byCategory
    ? Object.entries(analytics.byCategory)
    : Object.entries(categoryBreakdown);

  const filteredActionItems = result
    ? result.actionItems
        .map((item, originalIndex) => ({
          ...item,
          originalIndex,
        }))
        .filter((item) => {
          if (statusFilter === "All") {
            return true;
          }

          if (statusFilter === "High Priority") {
            return item.priority === "High";
          }

          return item.status === statusFilter;
        })
    : [];

  const currentMeetingTotalTasks = result ? result.actionItems.length : 0;
  const currentMeetingPendingTasks = result
    ? result.actionItems.filter((item) => item.status !== "Completed").length
    : 0;
  const currentMeetingCompletedTasks = result
    ? result.actionItems.filter((item) => item.status === "Completed").length
    : 0;
  const currentMeetingHighPriorityTasks = result
    ? result.actionItems.filter((item) => item.priority === "High").length
    : 0;

  const allUniqueTags = Array.from(
    new Set(history.flatMap((m) => m.tags || []))
  );

  const filteredHistory = history
    .filter((meeting) => {
      const searchText = search.toLowerCase();

      const matchesSearch =
        meeting.title.toLowerCase().includes(searchText) ||
        meeting.summary.toLowerCase().includes(searchText) ||
        (meeting.category || "General").toLowerCase().includes(searchText);

      const matchesDate = isWithinDateFilter(meeting.createdAt);

      const matchesCategory =
        categoryFilter === "All Categories" ||
        (meeting.category || "General") === categoryFilter;

      const matchesTag =
        tagFilter === "All Tags" ||
        (meeting.tags && meeting.tags.includes(tagFilter));

      return matchesSearch && matchesDate && matchesCategory && matchesTag;
    })
    .sort((a, b) => {
      if (sortOrder === "Newest First") {
        return new Date(b.createdAt) - new Date(a.createdAt);
      }

      if (sortOrder === "Oldest First") {
        return new Date(a.createdAt) - new Date(b.createdAt);
      }

      if (sortOrder === "Title A-Z") {
        return a.title.localeCompare(b.title);
      }

      if (sortOrder === "Title Z-A") {
        return b.title.localeCompare(a.title);
      }

      return 0;
    });

  // ============ W3 views & overlays ============

  // W3-C: kanban board view. Overdue is computed client-side from deadlines
  // (display-only); the other columns accept drops and PATCH the new status.
  const kanbanMeeting =
    history.find((m) => m._id === kanbanMeetingId) || history[0] || null;
  const kanbanItems = (kanbanMeeting?.actionItems || []).map((item, index) => ({
    ...item,
    index,
  }));
  const kanbanCols = [
    {
      name: "Pending",
      items: kanbanItems.filter(
        (i) =>
          (i.status || "Pending") === "Pending" &&
          !isOverdueLocal(i.deadline, i.status || "Pending")
      ),
    },
    {
      name: "In Progress",
      items: kanbanItems.filter(
        (i) => i.status === "In Progress" && !isOverdueLocal(i.deadline, i.status)
      ),
    },
    {
      name: "Overdue",
      computed: true,
      items: kanbanItems.filter((i) =>
        isOverdueLocal(i.deadline, i.status || "Pending")
      ),
    },
    {
      name: "Completed",
      items: kanbanItems.filter((i) => i.status === "Completed"),
    },
    {
      name: "Cancelled",
      items: kanbanItems.filter((i) => i.status === "Cancelled"),
    },
  ];

  const kanbanView = (
    <div className="card">
      <h2>Action Items Kanban</h2>
      <div className="filter-box">
        <label>Meeting:</label>
        <select
          value={kanbanMeeting?._id || ""}
          onChange={(e) => setKanbanMeetingId(e.target.value)}
          style={{ padding: "8px", minWidth: "220px" }}
        >
          {history.map((m) => (
            <option key={m._id} value={m._id}>
              {m.title}
            </option>
          ))}
        </select>
        {kanbanMeeting && (
          <button
            className="clear-btn"
            onClick={() => openMeetingById(kanbanMeeting._id)}
          >
            Open meeting
          </button>
        )}
      </div>

      {!kanbanMeeting ? (
        <p style={{ color: "#888" }}>No meetings yet — create one first.</p>
      ) : (
        <div className="kanban-board">
          {kanbanCols.map((col) => (
            <div
              key={col.name}
              className={`kanban-col${
                dragOverCol === col.name ? " kanban-col-dragover" : ""
              }`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOverCol(col.name);
              }}
              onDragLeave={() =>
                setDragOverCol((c) => (c === col.name ? null : c))
              }
              onDrop={(e) => handleKanbanDrop(e, col.name)}
            >
              <h4 className="kanban-col-title">
                {col.name} ({col.items.length})
                {col.computed && <span className="tiny-muted"> · auto</span>}
              </h4>
              {col.items.map((item) => (
                <div
                  key={item.index}
                  className="kanban-card"
                  draggable={!col.computed}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(
                      "application/json",
                      JSON.stringify({
                        meetingId: kanbanMeeting._id,
                        index: item.index,
                      })
                    );
                    e.dataTransfer.effectAllowed = "move";
                  }}
                >
                  <p className="kanban-task">{item.task}</p>
                  <p className="kanban-meta">
                    👤 {item.assignedTo || "Unassigned"}
                  </p>
                  <p className="kanban-meta">
                    📅 {item.deadline || "No deadline"}
                    {isOverdueLocal(item.deadline, item.status) && " · Overdue"}
                  </p>
                  <span
                    className={`priority-badge ${
                      item.priority === "High"
                        ? "priority-high"
                        : item.priority === "Medium"
                          ? "priority-medium"
                          : "priority-low"
                    }`}
                    style={{
                      fontSize: "11px",
                      padding: "3px 10px",
                      minWidth: "auto",
                    }}
                  >
                    {item.priority || "Medium"}
                  </span>
                </div>
              ))}
              {col.items.length === 0 && (
                <p className="kanban-empty">
                  {col.computed ? "Nothing overdue" : "Drop cards here"}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
      <p style={{ fontSize: "12px", color: "#888", marginTop: "12px" }}>
        Drag a card onto a status column to update it. The Overdue column is
        computed from deadlines and is display-only.
      </p>
    </div>
  );

  // W3-D: decision log view with search + pagination
  const decisionTotalPages = Math.max(1, Math.ceil(decisionTotal / 10));
  const decisionsView = (
    <div className="card">
      <h2>Decision Log</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setDecisionPage(1);
          fetchDecisions(1, decisionSearch);
        }}
        style={{ display: "flex", gap: "10px", marginBottom: "15px" }}
      >
        <input
          type="text"
          placeholder="Search decisions..."
          value={decisionSearch}
          onChange={(e) => setDecisionSearch(e.target.value)}
          style={{ flex: 1, padding: "10px" }}
        />
        <button type="submit">Search</button>
      </form>

      {decisionLoading ? (
        <p>Loading decisions…</p>
      ) : decisions.length === 0 ? (
        <p style={{ color: "#888" }}>No decisions found.</p>
      ) : (
        <>
          {decisions.map((d, i) => (
            <div
              key={`${d.meetingId || "x"}-${i}`}
              className="decision-row"
              onClick={() => d.meetingId && openMeetingById(d.meetingId)}
              style={{ cursor: d.meetingId ? "pointer" : "default" }}
              title={d.meetingId ? "Open meeting" : ""}
            >
              <p className="decision-text">🎯 {d.decision}</p>
              <p className="decision-meta">
                {d.meetingTitle || "Untitled meeting"}
                {d.date ? ` · ${new Date(d.date).toLocaleDateString()}` : ""}
              </p>
            </div>
          ))}
          <div className="pagination">
            <button
              className="clear-btn"
              disabled={decisionPage <= 1}
              onClick={() => {
                const p = decisionPage - 1;
                setDecisionPage(p);
                fetchDecisions(p, decisionSearch);
              }}
            >
              ← Prev
            </button>
            <span>
              Page {decisionPage} of {decisionTotalPages}
            </span>
            <button
              className="clear-btn"
              disabled={decisionPage >= decisionTotalPages}
              onClick={() => {
                const p = decisionPage + 1;
                setDecisionPage(p);
                fetchDecisions(p, decisionSearch);
              }}
            >
              Next →
            </button>
          </div>
        </>
      )}
    </div>
  );

  // W3-L: onboarding tour overlay (dismissed permanently via localStorage)
  const tourStepSafe = Math.min(tourStep, TOUR_STEPS.length - 1);
  const tourOverlay = showTour ? (
    <div className="tour-overlay">
      <div className="tour-card">
        <h3>{TOUR_STEPS[tourStepSafe].title}</h3>
        <p>{TOUR_STEPS[tourStepSafe].text}</p>
        <p className="tour-progress">
          Step {tourStepSafe + 1} of {TOUR_STEPS.length}
        </p>
        <div className="tour-actions">
          <div>
            {tourStepSafe > 0 && (
              <button
                className="clear-btn"
                onClick={() => setTourStep(tourStepSafe - 1)}
              >
                Back
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: "10px" }}>
            <button className="clear-btn" onClick={finishTour}>
              Skip
            </button>
            <button
              onClick={() => {
                if (tourStepSafe >= TOUR_STEPS.length - 1) finishTour();
                else setTourStep(tourStepSafe + 1);
              }}
            >
              {tourStepSafe >= TOUR_STEPS.length - 1 ? "Finish" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  ) : null;

  // W3-A: keyboard shortcuts dialog
  const shortcutsDialog = showShortcuts ? (
    <div className="modal-overlay" onClick={() => setShowShortcuts(false)}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h3>Keyboard shortcuts</h3>
        <ul className="shortcuts-list">
          <li>
            <kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>K</kbd> — focus meeting
            search
          </li>
          <li>
            <kbd>n</kbd> — start a new meeting (when not typing)
          </li>
          <li>
            <kbd>Esc</kbd> — close dialogs & panels
          </li>
        </ul>
        <div className="modal-actions">
          <button onClick={() => setShowShortcuts(false)}>Close</button>
        </div>
      </div>
    </div>
  ) : null;

  // W3-O: email summary dialog (never auto-sends)
  const emailDialog = showEmailDialog ? (
    <div className="modal-overlay" onClick={() => setShowEmailDialog(false)}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h3>Email meeting summary</h3>
        <p style={{ fontSize: "13px", color: "#888" }}>
          Recipient emails (comma-separated):
        </p>
        <input
          type="text"
          placeholder="a@example.com, b@example.com"
          value={emailRecipients}
          onChange={(e) => setEmailRecipients(e.target.value)}
          style={{ width: "100%", padding: "10px", boxSizing: "border-box" }}
        />
        {emailSetupHint && <p className="email-hint">{emailSetupHint}</p>}
        <div className="modal-actions">
          <button
            className="clear-btn"
            onClick={() => setShowEmailDialog(false)}
          >
            Cancel
          </button>
          <button onClick={sendSummaryEmail} disabled={emailSending}>
            {emailSending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  const sendChatMessage = async () => {
    if (!chatInput.trim() || !result) return;

    const userMessage = chatInput;
    setChatInput("");
    setChatMessages((prev) => [...prev, { sender: "user", text: userMessage }]);
    setChatLoading(true);

    try {
const response = await fetch(`${API_BASE}/api/meetings/${result._id}/chat`, {

        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          message: userMessage,
        }),
      });

      const data = await response.json();
      if (response.ok) {
        setChatMessages((prev) => [...prev, { sender: "ai", text: data.reply }]);
        // Phase P11: honest chat-source labeling ("llm" | "rule-based")
        setChatAiSource(data.aiSource || null);
      } else {
        setChatMessages((prev) => [...prev, { sender: "ai", text: data.message || "Failed to get response." }]);
        setChatAiSource(null);
      }
    } catch (error) {
      console.error(error);
      setChatMessages((prev) => [...prev, { sender: "ai", text: "Network error. Please try again." }]);
    } finally {
      setChatLoading(false);
    }
  };

  // Phase P11: LLM-powered summary via
  // POST /api/meetings/:id/ai-summary?save=true (Bearer auth).
  // 200 → merge LLM fields into result, extractionMethod becomes "llm".
  // 502 → backend LLM failed; merge data.fallback with
  // extractionMethod "rule-based" and say so honestly.
  const generateAiSummary = async () => {
    if (!result) return;

    setAiSummaryLoading(true);
    try {
      const response = await fetch(`${API_URL}/${result._id}/ai-summary?save=true`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      const data = await response.json();

      if (response.ok) {
        setResult((prev) => ({
          ...prev,
          summary: data.summary ?? prev.summary,
          keyPoints: data.keyPoints ?? prev.keyPoints,
          decisions: data.decisions ?? prev.decisions,
          risks: data.risks ?? prev.risks,
          blockers: data.blockers ?? prev.blockers,
          openQuestions: data.openQuestions ?? prev.openQuestions,
          importantTopics: data.importantTopics ?? prev.importantTopics,
          actionItems: data.actionItems ?? prev.actionItems,
          extractionMethod: "llm",
        }));
        toast.success("AI summary generated");
        await fetchMeetings();
      } else if (response.status === 502 && data.fallback) {
        const fb = data.fallback;
        setResult((prev) => ({
          ...prev,
          summary: fb.summary ?? prev.summary,
          keyPoints: fb.keyPoints ?? prev.keyPoints,
          decisions: fb.decisions ?? prev.decisions,
          risks: fb.risks ?? prev.risks,
          blockers: fb.blockers ?? prev.blockers,
          openQuestions: fb.openQuestions ?? prev.openQuestions,
          importantTopics: fb.importantTopics ?? prev.importantTopics,
          actionItems: fb.actionItems ?? prev.actionItems,
          extractionMethod: "rule-based",
        }));
        toast.warn("AI unavailable — used rule-based fallback");
        await fetchMeetings();
      } else {
        toast.error(data.message || "AI summary generation failed");
      }
    } catch (error) {
      toast.error("AI summary generation failed. Please check backend server.");
      console.log("Error generating AI summary:", error);
    } finally {
      setAiSummaryLoading(false);
    }
  };

  // Phase P1-fix-B2: reset-password view. Takes precedence over the normal
  // auth/main UI whenever a `#/reset/<token>` link is open, regardless of
  // login state. An empty token (invalid link) falls through to normal UI.
  if (resetToken) {
    return (
      <div className={darkMode ? "app-container dark-mode" : "app-container"}>
        <ToastContainer />
        <div className="card auth-card" style={{ maxWidth: "400px", margin: "50px auto", padding: "25px" }}>
          <h1>Meeting Summarizer</h1>

          <button onClick={toggleDarkMode} className="clear-btn" style={{ marginBottom: "15px" }}>
            {darkMode ? "Light Mode" : "Dark Mode"}
          </button>

          <h2>Reset Password</h2>

          <form onSubmit={handleResetPassword}>
            <input
              type="password"
              placeholder="New password"
              value={newResetPassword}
              onChange={(e) => setNewResetPassword(e.target.value)}
              style={{ width: "100%", padding: "10px", marginBottom: "10px", boxSizing: "border-box" }}
            />

            <input
              type="password"
              placeholder="Confirm password"
              value={confirmResetPassword}
              onChange={(e) => setConfirmResetPassword(e.target.value)}
              style={{ width: "100%", padding: "10px", marginBottom: "15px", boxSizing: "border-box" }}
            />

            <button
              type="submit"
              disabled={resetSubmitting}
              style={{ width: "100%", padding: "10px", background: "#007bff", color: "white", border: "none", cursor: "pointer", borderRadius: "4px" }}
            >
              {resetSubmitting ? "Updating..." : "Update Password"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // W3-K: tasteful landing page for logged-out visitors (no hash or
  // #/welcome). "Get started →" switches to the login/register card, which
  // stays reachable via "Back to welcome".
  const landingHash = window.location.hash;
  const showLanding =
    !showAuth &&
    (landingHash === "" || landingHash === "#/" || landingHash === "#/welcome");

  if (!token && showLanding) {
    return (
      <div className={darkMode ? "app-container dark-mode" : "app-container"}>
        <ToastContainer />
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button onClick={toggleDarkMode} className="clear-btn">
            {darkMode ? "Light Mode" : "Dark Mode"}
          </button>
        </div>
        <div className="landing-hero">
          <h1>AI Meeting Intelligence Platform</h1>
          <p className="landing-sub">
            Turn every meeting into decisions, action items, and answers.
          </p>
          <ul className="landing-features">
            <li>✨ AI summaries via Groq</li>
            <li>✅ Action-item tracking with a Kanban board</li>
            <li>👥 Workspaces & role-based access</li>
            <li>🔎 Ask-across-meetings RAG Q&A with citations</li>
            <li>🎙️ Audio transcription</li>
            <li>📊 Productivity analytics & sentiment trends</li>
          </ul>
          <p className="landing-screenshots">
            [ screenshots placeholder — product tour coming soon ]
          </p>
          <button className="landing-cta" onClick={() => setShowAuth(true)}>
            Get started →
          </button>
        </div>
      </div>
    );
  }

  if (!token) {
    return (
      <div className={darkMode ? "app-container dark-mode" : "app-container"}>
        <ToastContainer />
        <div className="card auth-card" style={{ maxWidth: "400px", margin: "50px auto", padding: "25px" }}>
          <h1>Meeting Summarizer</h1>

          <button onClick={toggleDarkMode} className="clear-btn" style={{ marginBottom: "15px" }}>
            {darkMode ? "Light Mode" : "Dark Mode"}
          </button>

          <h2>{authMode === "login" ? "Login" : "Register"}</h2>

          <form onSubmit={handleAuth}>
            {authMode === "register" && (
              <input
                type="text"
                placeholder="Enter your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                style={{ width: "100%", padding: "10px", marginBottom: "10px", boxSizing: "border-box" }}
              />
            )}

            <input
              type="email"
              placeholder="Enter email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              style={{ width: "100%", padding: "10px", marginBottom: "10px", boxSizing: "border-box" }}
            />

            <input
              type="password"
              placeholder="Enter password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              style={{ width: "100%", padding: "10px", marginBottom: "10px", boxSizing: "border-box" }}
            />

            {!showForgotPassword ? (
              <div style={{ marginBottom: "15px", textAlign: "right" }}>
                <span
                  style={{ color: "#007bff", cursor: "pointer", fontSize: "13px" }}
                  onClick={() => setShowForgotPassword(true)}
                >
                  Forgot Password?
                </span>
              </div>
            ) : (
              <div style={{ marginBottom: "15px", padding: "10px", border: "1px solid #ccc", borderRadius: "4px" }}>
                <p style={{ fontSize: "12px", color: "#666" }}>Enter registered email to reset:</p>
                <input
                  type="email"
                  placeholder="Enter email"
                  value={forgotEmail}
                  onChange={(e) => setForgotEmail(e.target.value)}
                  style={{ width: "100%", padding: "8px", marginBottom: "8px", boxSizing: "border-box" }}
                />
                <button
                  type="button"
                  onClick={handleForgotPassword}
                  style={{ width: "100%", padding: "6px", background: "#007bff", color: "white", border: "none", cursor: "pointer", borderRadius: "4px" }}
                >
                  Send Reset Link
                </button>
                <div style={{ marginTop: "5px", textAlign: "right" }}>
                  <span
                    style={{ color: "red", cursor: "pointer", fontSize: "11px" }}
                    onClick={() => setShowForgotPassword(false)}
                  >
                    Back to Login
                  </span>
                </div>
              </div>
            )}

            <button type="submit" style={{ width: "100%", padding: "10px", background: "#007bff", color: "white", border: "none", cursor: "pointer", borderRadius: "4px" }}>
              {authMode === "login" ? "Login" : "Register"}
            </button>
          </form>

          <p style={{ textAlign: "center", marginTop: "15px" }}>
            {authMode === "login"
              ? "Don't have an account?"
              : "Already have an account?"}
          </p>

          <button
            type="button"
            className="clear-btn"
            onClick={() =>
              setAuthMode(authMode === "login" ? "register" : "login")
            }
            style={{ width: "100%", padding: "8px", marginTop: "5px" }}
          >
            {authMode === "login" ? "Create Account" : "Back to Login"}
          </button>
          {showAuth && (
            <button
              type="button"
              className="clear-btn"
              onClick={() => setShowAuth(false)}
              style={{ width: "100%", padding: "8px", marginTop: "8px" }}
            >
              ← Back to welcome
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={darkMode ? "app-container dark-mode" : "app-container"}>
      <ToastContainer />
      <h1>Meeting Summarizer & Intelligence Hub</h1>

      {/* W3: view navigation — Dashboard / Kanban / Decisions */}
      <div className="view-tabs">
        <button
          onClick={() => showView("main")}
          className={view === "main" ? "view-tab-active" : "clear-btn"}
        >
          📊 Dashboard
        </button>
        <button
          onClick={() => showView("kanban")}
          className={view === "kanban" ? "view-tab-active" : "clear-btn"}
        >
          🗂️ Kanban
        </button>
        <button
          onClick={() => showView("decisions")}
          className={view === "decisions" ? "view-tab-active" : "clear-btn"}
        >
          🎯 Decisions
        </button>
      </div>

      {view === "main" ? (
      <>
      <div className="user-bar">
        <p>Welcome, {user?.name || "User"}</p>

        <div className="user-actions">
          {/* Phase P5: notifications bell with dropdown panel */}
          <div style={{ position: "relative" }}>
            <button
              onClick={() => setShowNotifications(!showNotifications)}
              className="clear-btn"
            >
              🔔 ({unreadCount})
            </button>

            {showNotifications && (
              <div
                className="card"
                style={{
                  position: "absolute",
                  right: 0,
                  top: "100%",
                  marginTop: "8px",
                  width: "340px",
                  maxHeight: "380px",
                  overflowY: "auto",
                  zIndex: 1000,
                  padding: "12px",
                }}
              >
                <h3 style={{ margin: "0 0 10px 0" }}>Notifications</h3>

                {notifications.length === 0 ? (
                  <p style={{ color: "#888" }}>No notifications.</p>
                ) : (
                  notifications.map((n) => (
                    <div
                      key={n._id}
                      onClick={() => markNotificationRead(n._id)}
                      style={{
                        padding: "8px",
                        marginBottom: "8px",
                        borderRadius: "6px",
                        background: n.read
                          ? "transparent"
                          : darkMode
                            ? "#1e293b"
                            : "#f1f5f9",
                        cursor: "pointer",
                        borderBottom: "1px solid #eee",
                      }}
                    >
                      <p
                        style={{
                          fontWeight: n.read ? "normal" : "bold",
                          margin: "0 0 4px 0",
                        }}
                      >
                        {n.title}
                      </p>
                      <p
                        style={{
                          margin: "0 0 4px 0",
                          fontSize: "13px",
                        }}
                      >
                        {n.body}
                      </p>
                      <p
                        style={{
                          margin: 0,
                          fontSize: "11px",
                          color: "#888",
                        }}
                      >
                        {n.createdAt
                          ? new Date(n.createdAt).toLocaleString()
                          : ""}
                      </p>
                    </div>
                  ))
                )}

                {notifications.length > 0 && (
                  <button
                    onClick={markAllNotificationsRead}
                    className="clear-btn"
                    style={{ width: "100%", marginTop: "6px" }}
                  >
                    Mark all read
                  </button>
                )}
              </div>
            )}
          </div>

          {/* W3-A: keyboard shortcuts */}
          <button
            onClick={() => setShowShortcuts(true)}
            className="clear-btn"
            title="Keyboard shortcuts"
            aria-label="Keyboard shortcuts"
          >
            ?
          </button>

          <button onClick={toggleDarkMode} className="clear-btn">
            {darkMode ? "Light Mode" : "Dark Mode"}
          </button>

          <button onClick={logout} className="delete-btn">
            Logout
          </button>
        </div>
      </div>

      {/* Phase P4: workspaces & collaboration */}
      <div className="card">
        <h2>Workspaces</h2>

        {workspaces.length === 0 ? (
          <p style={{ color: "#888" }}>No workspaces yet — create one below.</p>
        ) : (
          workspaces.map((ws) => (
            <div
              key={ws._id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                padding: "6px 0",
                borderBottom: "1px solid #eee",
              }}
            >
              <span style={{ flex: 1 }}>
                <strong>{ws.name}</strong>{" "}
                <span style={{ color: "#888" }}>({ws.myRole})</span>
              </span>
              {(ws.myRole === "owner" || ws.myRole === "admin") && (
                <button
                  onClick={() => createInviteLink(ws._id)}
                  className="clear-btn"
                >
                  Invite
                </button>
              )}
            </div>
          ))
        )}

        <div
          className="filter-box"
          style={{ display: "flex", gap: "10px", marginTop: "10px" }}
        >
          <input
            type="text"
            placeholder="New workspace name..."
            value={newWorkspaceName}
            onChange={(e) => setNewWorkspaceName(e.target.value)}
            style={{ flex: 1, padding: "8px" }}
          />
          <button onClick={createWorkspace}>Create</button>
        </div>

        {inviteLink && (
          <div style={{ marginTop: "10px" }}>
            <label>
              <strong>Invite link:</strong>
            </label>
            <div style={{ display: "flex", gap: "10px", marginTop: "5px" }}>
              <input
                type="text"
                readOnly
                value={inviteLink}
                style={{ flex: 1, padding: "8px" }}
              />
              <button onClick={copyInviteLink}>Copy</button>
            </div>
          </div>
        )}
      </div>

      {/* Phase P5: notification preferences */}
      <div className="card">
        <h2>Notification Preferences</h2>

        <form onSubmit={savePreferences}>
          <div style={{ marginBottom: "10px" }}>
            <label>
              <strong>Timezone</strong>
            </label>
            <input
              type="text"
              placeholder="Asia/Kolkata"
              value={prefsForm.timezone}
              onChange={(e) =>
                setPrefsForm({ ...prefsForm, timezone: e.target.value })
              }
              style={{
                width: "100%",
                padding: "8px",
                marginTop: "4px",
                boxSizing: "border-box",
              }}
            />
          </div>

          <div style={{ marginBottom: "10px" }}>
            <label>
              <strong>Remind me (hours before deadline)</strong>
            </label>
            <input
              type="number"
              min="1"
              max="168"
              value={prefsForm.reminderHoursBefore}
              onChange={(e) =>
                setPrefsForm({
                  ...prefsForm,
                  reminderHoursBefore: Number(e.target.value),
                })
              }
              style={{
                width: "100%",
                padding: "8px",
                marginTop: "4px",
                boxSizing: "border-box",
              }}
            />
          </div>

          <div style={{ marginBottom: "12px" }}>
            <label
              style={{
                display: "flex",
                gap: "8px",
                alignItems: "center",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={prefsForm.emailEnabled}
                onChange={(e) =>
                  setPrefsForm({
                    ...prefsForm,
                    emailEnabled: e.target.checked,
                  })
                }
              />
              <span>Email notifications</span>
            </label>
            <p style={{ fontSize: "12px", color: "#888", marginTop: "4px" }}>
              (email sending is stubbed — needs SMTP setup; in-app
              notifications always work)
            </p>
          </div>

          <button type="submit">Save</button>
        </form>
      </div>

      {/* Phase P6: integrations — credential-gated stubs. Connection status
          is shown honestly, and every action surfaces the backend `note`
          message explaining what works without OAuth/Slack-webhook setup.
          Nothing here sends or imports real data unless the backend is
          fully configured. */}
      <div className="card">
        <h2>Integrations</h2>

        {/* Google row */}
        <div style={{ padding: "8px 0", borderBottom: "1px solid #eee" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              flexWrap: "wrap",
            }}
          >
            <strong style={{ flex: 1 }}>Google</strong>
            <span
              style={{
                color: integStatus?.google?.connected ? "green" : "#888",
              }}
            >
              {integStatus?.google?.connected ? "Connected" : "Not connected"}
            </span>
            <button onClick={connectGoogle}>Connect</button>
            <button
              onClick={() => disconnectIntegration("google")}
              className="clear-btn"
            >
              Disconnect
            </button>
          </div>
        </div>

        {/* Slack row */}
        <div style={{ padding: "8px 0", borderBottom: "1px solid #eee" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              flexWrap: "wrap",
            }}
          >
            <strong style={{ flex: 1 }}>Slack</strong>
            <span
              style={{
                color: integStatus?.slack?.connected ? "green" : "#888",
              }}
            >
              {integStatus?.slack?.connected ? "Connected" : "Not connected"}
            </span>
            <button
              onClick={() => disconnectIntegration("slack")}
              className="clear-btn"
            >
              Disconnect
            </button>
          </div>
          <div style={{ display: "flex", gap: "10px", marginTop: "8px" }}>
            <input
              type="text"
              placeholder="Test message..."
              value={slackText}
              onChange={(e) => setSlackText(e.target.value)}
              style={{ flex: 1, padding: "8px" }}
            />
            <button onClick={sendSlackTest}>Send test</button>
          </div>
          {slackResult?.note && (
            <p style={{ fontSize: "12px", color: "#888", margin: "6px 0 0 0" }}>
              {slackResult.note}
            </p>
          )}
        </div>

        {/* Calendar import row */}
        <div style={{ padding: "8px 0", borderBottom: "1px solid #eee" }}>
          <strong>Google Calendar import</strong>
          <div
            style={{
              display: "flex",
              gap: "10px",
              marginTop: "8px",
              flexWrap: "wrap",
            }}
          >
            <input
              type="date"
              value={calFrom}
              onChange={(e) => setCalFrom(e.target.value)}
              style={{ padding: "8px" }}
            />
            <input
              type="date"
              value={calTo}
              onChange={(e) => setCalTo(e.target.value)}
              style={{ padding: "8px" }}
            />
            <button onClick={importCalendar}>Import</button>
          </div>
          {calResult?.note && (
            <p style={{ fontSize: "12px", color: "#888", margin: "6px 0 0 0" }}>
              {calResult.note}
            </p>
          )}
        </div>

        {/* Gmail draft row — only shown when a meeting is open */}
        {result && (
          <div style={{ padding: "8px 0", borderBottom: "1px solid #eee" }}>
            <strong>Gmail draft for this meeting</strong>
            <div style={{ display: "flex", gap: "10px", marginTop: "8px" }}>
              <input
                type="email"
                placeholder="Recipient email..."
                value={gmailTo}
                onChange={(e) => setGmailTo(e.target.value)}
                style={{ flex: 1, padding: "8px" }}
              />
              <button onClick={buildGmailDraft}>Build draft</button>
            </div>
            {gmailDraft?.draft && (
              <div style={{ marginTop: "8px" }}>
                <textarea
                  readOnly
                  rows="8"
                  value={`Subject: ${gmailDraft.draft.subject}\n\n${gmailDraft.draft.body}`}
                  style={{
                    width: "100%",
                    padding: "8px",
                    boxSizing: "border-box",
                  }}
                />
              </div>
            )}
            {gmailDraft?.note && (
              <p
                style={{
                  fontSize: "12px",
                  color: "#888",
                  margin: "6px 0 0 0",
                }}
              >
                {gmailDraft.note} (nothing was sent)
              </p>
            )}
          </div>
        )}

        <p style={{ fontSize: "12px", color: "#888", marginTop: "10px" }}>
          Setup instructions: see backend/INTEGRATIONS.md — OAuth, encryption
          key, and Slack webhook required for live use.
        </p>
      </div>

      {/* Phase P12: RAG Q&A across meetings. The source badge is honest:
          "rule-based" means lexical-retrieval excerpts — never labeled as
          AI-generated. */}
      <div className="card">
        <h2>Ask Across Meetings</h2>
        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
          <input
            type="text"
            placeholder="Ask a question across all your meetings…"
            value={ragQuestion}
            onChange={(e) => setRagQuestion(e.target.value)}
            style={{ flex: 1, padding: "8px", minWidth: "200px" }}
          />
          <button onClick={askAcrossMeetings} disabled={ragLoading}>
            {ragLoading ? "Asking…" : "Ask"}
          </button>
        </div>

        {ragAnswer !== null && (
          <div style={{ marginTop: "12px" }}>
            <div
              style={{
                whiteSpace: "pre-wrap",
                padding: "10px",
                background: "#f7f7f7",
                borderRadius: "6px",
              }}
            >
              {ragAnswer}
            </div>
            <div style={{ marginTop: "8px", fontSize: "13px" }}>
              {ragAiSource === "llm" && (
                <span role="img" aria-label="AI answer">
                  ✨ AI answer (Groq)
                </span>
              )}
              {ragAiSource === "rule-based" && (
                <span style={{ color: "#888" }}>
                  (lexical retrieval — excerpts, not AI-generated)
                </span>
              )}
              {ragAiSource === "none" && (
                <span style={{ color: "#888" }}>No meetings to search.</span>
              )}
              {/* W3-P/Q: optional retrieval-method label */}
              {ragRetrievalMethod && (
                <span style={{ color: "#888" }}>
                  {" "}· retrieval: {ragRetrievalMethod}
                </span>
              )}
            </div>
            {ragNote && (
              <p style={{ fontSize: "12px", color: "#888", marginTop: "6px" }}>
                {ragNote}
              </p>
            )}
            {ragCitations.length > 0 && (
              <div style={{ marginTop: "10px" }}>
                <strong>Sources</strong>
                <ul style={{ marginTop: "6px", paddingLeft: "20px" }}>
                  {ragCitations.map((c, idx) => (
                    <li key={c.meetingId || idx} style={{ marginBottom: "8px" }}>
                      <span>📄 {c.title || "Untitled meeting"}</span>
                      {c.excerpt && (
                        <div
                          style={{
                            fontSize: "12px",
                            color: "#555",
                            marginTop: "2px",
                          }}
                        >
                          {c.excerpt}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="dashboard">
        <div className="dashboard-card">
          <h3>Total Meetings</h3>
          <p>{analytics?.totalMeetings ?? totalMeetings}</p>
        </div>

        <div className="dashboard-card">
          <h3>Total Action Items</h3>
          <p>{analytics?.actionItems?.total ?? totalActionItems}</p>
        </div>

        <div className="dashboard-card">
          <h3>Pending Tasks</h3>
          <p>{analytics?.actionItems?.pending ?? pendingTasks}</p>
        </div>

        <div className="dashboard-card">
          <h3>Completed Tasks</h3>
          <p>{analytics?.actionItems?.completed ?? completedTasks}</p>
        </div>

        <div className="dashboard-card">
          <h3>High Priority</h3>
          <p>{analytics?.actionItems?.byPriority?.High ?? highPriorityTasks}</p>
        </div>

        <div className="dashboard-card">
          <h3>Overdue</h3>
          <p>{analytics?.actionItems?.overdue ?? "—"}</p>
        </div>
      </div>

      <div className="card">
        <h2>Productivity & Task Completion Analytics</h2>
        <p>Overall Execution: <strong>{displayCompletionPct}% Completed</strong></p>
        <div className="progress-bar" style={{ marginBottom: "15px" }}>
          <div
            className="progress-fill"
            style={{ width: `${displayCompletionPct}%` }}
          ></div>
        </div>

        {analytics?.avgDurationMinutes != null && (
          <p>Average meeting duration: <strong>{analytics.avgDurationMinutes} min</strong></p>
        )}

        {/* W3-H: total meeting cost from analytics */}
        {analytics?.totalCost != null && (
          <p>Total meeting cost: <strong>${Number(analytics.totalCost).toFixed(2)}</strong></p>
        )}

        {/* W3-E: rule-based sentiment trend from analytics */}
        {analytics?.sentimentTrend && (
          <div style={{ marginTop: "10px" }}>
            <h4>
              Sentiment Trend{" "}
              <span className="tiny-muted">Rule-based sentiment</span>
            </h4>
            <ul style={{ paddingLeft: "15px", margin: "5px 0" }}>
              <li>😊 Positive: {analytics.sentimentTrend.Positive ?? 0}</li>
              <li>😐 Neutral: {analytics.sentimentTrend.Neutral ?? 0}</li>
              <li>😟 Negative: {analytics.sentimentTrend.Negative ?? 0}</li>
              <li>Unknown: {analytics.sentimentTrend.Unknown ?? 0}</li>
            </ul>
          </div>
        )}

        <div style={{ display: "flex", gap: "15px", flexWrap: "wrap", marginTop: "10px" }}>
          <div style={{ flex: 1, padding: "10px", background: darkMode ? "#222" : "#f1f5f9", borderRadius: "6px" }}>
            <h4>Category Breakdown</h4>
            <ul style={{ paddingLeft: "15px", margin: "5px 0" }}>
              {displayCategoryEntries.length === 0 ? <p>No categories yet</p> : null}
              {displayCategoryEntries.map(([cat, count]) => (
                <li key={cat}><strong>{cat}:</strong> {count} meeting(s)</li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {editMode && (
        <div className="card">
          <h2>Edit Mode Active</h2>
          <p>You are editing an existing saved meeting.</p>
        </div>
      )}

      {/* W3-B: meeting templates prefill the form below */}
      <div className="card">
        <h3 style={{ margin: "0 0 10px 0" }}>Start from a template</h3>
        <div className="template-picker">
          {MEETING_TEMPLATES.map((t) => (
            <button
              key={t.name}
              type="button"
              className="clear-btn"
              onClick={() => applyTemplate(t)}
            >
              {t.name}
            </button>
          ))}
        </div>
      </div>

      <input
        id="meeting-title-input"
        type="text"
        placeholder="Enter meeting title..."
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="title-input"
      />

      <div style={{ display: "flex", gap: "10px", marginBottom: "15px" }}>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          style={{ flex: 1, padding: "10px" }}
        >
          <option value="General">General</option>
          <option value="Project">Project</option>
          <option value="College">College</option>
          <option value="Client">Client</option>
          <option value="Personal">Personal</option>
          <option value="Urgent">Urgent</option>
        </select>

        <input
          type="text"
          placeholder="Tags (comma separated, e.g., sprint, backend, review)"
          value={tagsInput}
          onChange={(e) => setTagsInput(e.target.value)}
          style={{ flex: 2, padding: "10px" }}
        />
      </div>

      {/* W3-H/I: optional cost inputs + recurrence for the new meeting */}
      <div
        style={{
          display: "flex",
          gap: "10px",
          marginBottom: "15px",
          flexWrap: "wrap",
        }}
      >
        <div style={{ flex: 1, minWidth: "150px" }}>
          <label>
            <strong>Hourly rate ($, optional)</strong>
          </label>
          <input
            type="number"
            min="0"
            step="0.01"
            placeholder="e.g., 50"
            value={hourlyRate}
            onChange={(e) => setHourlyRate(e.target.value)}
            style={{ width: "100%", padding: "10px", marginTop: "4px" }}
          />
        </div>
        <div style={{ flex: 1, minWidth: "150px" }}>
          <label>
            <strong>Participants (optional)</strong>
          </label>
          <input
            type="number"
            min="1"
            step="1"
            placeholder="e.g., 4"
            value={participantCount}
            onChange={(e) => setParticipantCount(e.target.value)}
            style={{ width: "100%", padding: "10px", marginTop: "4px" }}
          />
        </div>
        <div style={{ flex: 1, minWidth: "150px" }}>
          <label>
            <strong>Recurrence</strong>
          </label>
          <select
            value={recurrenceFrequency}
            onChange={(e) => setRecurrenceFrequency(e.target.value)}
            style={{ width: "100%", padding: "10px", marginTop: "4px" }}
          >
            <option value="None">None</option>
            <option value="weekly">Weekly</option>
            <option value="biweekly">Biweekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </div>
        {recurrenceFrequency !== "None" && (
          <div style={{ flex: 1, minWidth: "150px" }}>
            <label>
              <strong>Occurrences</strong>
            </label>
            <input
              type="number"
              min="1"
              step="1"
              value={recurrenceOccurrences}
              onChange={(e) => setRecurrenceOccurrences(e.target.value)}
              style={{ width: "100%", padding: "10px", marginTop: "4px" }}
            />
          </div>
        )}
      </div>

      <div className="audio-upload-box">
        <label>Upload Meeting Audio</label>
        <input type="file" accept="audio/*" onChange={uploadAudio} />
        {audioLoading && <p>Converting audio to text...</p>}
      </div>

      <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: "300px" }}>
          <label><strong>Meeting Transcript:</strong></label>
          <textarea
            rows="8"
            placeholder="Paste your meeting transcript here or upload audio..."
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            style={{ width: "100%", marginTop: "5px" }}
          ></textarea>
        </div>

        <div style={{ flex: 1, minWidth: "300px" }}>
          <label><strong>Manual Notes / Scratchpad:</strong></label>
          <textarea
            rows="8"
            placeholder="Add manual notes or key thoughts here..."
            value={manualNotes}
            onChange={(e) => setManualNotes(e.target.value)}
            style={{ width: "100%", marginTop: "5px" }}
          ></textarea>
        </div>
      </div>

      <div className="button-group" style={{ marginTop: "15px" }}>
        <button onClick={generateSummary}>
          {loading ? "Generating Intelligence..." : "Generate Insights & Summary"}
        </button>

        {editMode && (
          <button onClick={updateMeeting}>
            {loading ? "Updating..." : "Update Meeting"}
          </button>
        )}

        <button onClick={() => clearAll()} className="clear-btn">
          Clear
        </button>

        <button onClick={startNewMeeting} className="clear-btn">
          New Meeting
        </button>
      </div>

      {result && (
        <div className="result-box">
          <div className="dashboard">
            <div className="dashboard-card">
              <h3>Meeting Tasks</h3>
              <p>{currentMeetingTotalTasks}</p>
            </div>

            <div className="dashboard-card">
              <h3>Pending</h3>
              <p>{currentMeetingPendingTasks}</p>
            </div>

            <div className="dashboard-card">
              <h3>Completed</h3>
              <p>{currentMeetingCompletedTasks}</p>
            </div>

            <div className="dashboard-card">
              <h3>High Priority</h3>
              <p>{currentMeetingHighPriorityTasks}</p>
            </div>
          </div>

          <div className="card">
            <h2>{title || "Untitled Meeting"}</h2>
            {/* W3-J: realtime presence indicator */}
            {liveConnected && (
              <p className="live-indicator">
                <span className="live-dot">●</span> Live · {collaborators}{" "}
                online
              </p>
            )}
            <p>
              <strong>Category:</strong> {category} | <strong>Tags:</strong>{" "}
              {result.tags && result.tags.length > 0 ? result.tags.join(", ") : "None"}
            </p>

            {/* Phase P4: meeting sharing / visibility (owner only, backend-enforced) */}
            <div
              className="filter-box"
              style={{
                display: "flex",
                gap: "10px",
                alignItems: "center",
                flexWrap: "wrap",
                marginTop: "10px",
              }}
            >
              <label>
                <strong>Visibility:</strong>
              </label>
              <select
                value={shareVisibility}
                onChange={(e) => setShareVisibility(e.target.value)}
                style={{ padding: "8px" }}
              >
                <option value="private">Private</option>
                <option value="workspace">Workspace</option>
              </select>

              {shareVisibility === "workspace" && (
                <select
                  value={shareWorkspaceId}
                  onChange={(e) => setShareWorkspaceId(e.target.value)}
                  style={{ padding: "8px" }}
                >
                  <option value="">Select workspace...</option>
                  {workspaces.map((ws) => (
                    <option key={ws._id} value={ws._id}>
                      {ws.name}
                    </option>
                  ))}
                </select>
              )}

              <button onClick={saveSharing}>Save sharing</button>
            </div>

            {/* Phase P11: LLM-powered AI summary (Bearer auth).
                Honest labeling: success marks extractionMethod "llm",
                LLM failure falls back to rule-based and says so. */}
            <div style={{ marginTop: "10px" }}>
              <button onClick={generateAiSummary} disabled={aiSummaryLoading}>
                {aiSummaryLoading ? "Generating…" : "✨ Generate AI Summary"}
              </button>
            </div>

            {/* W3-H: estimated cost from the meeting report */}
            {report?.cost != null && (
              <p style={{ marginTop: "10px" }}>
                Est. cost: <strong>${Number(report.cost).toFixed(2)}</strong>{" "}
                <span className="tiny-muted">(inputs)</span>
              </p>
            )}

            <div
              style={{
                marginTop: "10px",
                display: "flex",
                gap: "10px",
                flexWrap: "wrap",
              }}
            >
              {/* W3-O: email the summary (dialog, never auto-sends) */}
              <button
                onClick={() => {
                  setEmailSetupHint("");
                  setShowEmailDialog(true);
                }}
                className="clear-btn"
              >
                ✉️ Email summary
              </button>
              {/* W3-I: recurrence — create the next instance */}
              {result.recurrence?.frequency && (
                <button onClick={createNextInstance}>
                  Create next instance
                </button>
              )}
            </div>
            {result.recurrence?.frequency && (
              <p style={{ fontSize: "12px", color: "#888", marginTop: "6px" }}>
                Recurs {result.recurrence.frequency}
                {result.recurrence.occurrences
                  ? ` · ${result.recurrence.occurrences} occurrence(s)`
                  : ""}
              </p>
            )}
          </div>

          <div className="card">
            <h2>Summary</h2>
            <p>{result.summary}</p>
            <button onClick={copySummary}>Copy Summary</button>
          </div>

          <div className="card" style={{ background: darkMode ? "#1a2238" : "#f0f4f8" }}>
            <h2>Meeting Intelligence & Insights</h2>
            {/* Phase P11: honest extraction-method labeling — LLM output is
                labeled AI, rule-based stays labeled rule-based. */}
            {result.extractionMethod === "llm" ? (
              <p style={{ fontSize: "12px", color: "#7c3aed", fontWeight: "bold" }}>
                ✨ AI-generated summary (Groq)
              </p>
            ) : (
              <p style={{ fontSize: "12px", color: "#888" }}>
                (Rule-based extraction — not AI-generated)
              </p>
            )}

            <div style={{ marginTop: "10px" }}>
              <h3>🎯 Decisions</h3>
              {result.decisions && result.decisions.length > 0 ? (
                <ul>{result.decisions.map((d, i) => <li key={i}>{d}</li>)}</ul>
              ) : <p>No major decisions explicitly logged.</p>}
            </div>

            <div style={{ marginTop: "10px" }}>
              <h3>⚠️ Risks</h3>
              {result.risks && result.risks.length > 0 ? (
                <ul>{result.risks.map((r, i) => <li key={i}>{r}</li>)}</ul>
              ) : <p>No immediate risks flagged.</p>}
            </div>

            <div style={{ marginTop: "10px" }}>
              <h3>🚧 Blockers</h3>
              {result.blockers && result.blockers.length > 0 ? (
                <ul>{result.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
              ) : <p>No blockers reported.</p>}
            </div>

            <div style={{ marginTop: "10px" }}>
              <h3>❓ Open Questions</h3>
              {result.openQuestions && result.openQuestions.length > 0 ? (
                <ul>{result.openQuestions.map((q, i) => <li key={i}>{q}</li>)}</ul>
              ) : <p>No open questions remaining.</p>}
            </div>

            <div style={{ marginTop: "10px" }}>
              <h3>📌 Important Topics</h3>
              {result.importantTopics && result.importantTopics.length > 0 ? (
                <ul>{result.importantTopics.map((t, i) => <li key={i}>{t}</li>)}</ul>
              ) : <p>No specific topics highlighted.</p>}
            </div>
          </div>

          {/* W3-F: talk-time breakdown (heuristic speaker detection) */}
          <div className="card">
            <h2>
              Talk time <span className="tiny-muted">(heuristic)</span>
            </h2>
            {report?.talkTime?.length > 0 ? (
              <div className="talktime-chart">
                {report.talkTime.map((t, i) => (
                  <div key={i} className="talktime-row">
                    <span className="talktime-speaker" title={t.speaker}>
                      {t.speaker}
                    </span>
                    <div className="talktime-track">
                      <div
                        className="talktime-fill"
                        style={{
                          width: `${Math.max(0, Math.min(100, t.percent || 0))}%`,
                        }}
                      ></div>
                    </div>
                    <span className="talktime-pct">
                      {Math.round(t.percent || 0)}%
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p style={{ color: "#888" }}>
                No speaker labels detected — write 'Name:' before each
                speaker's lines. (Heuristic)
              </p>
            )}
          </div>

          <div className="card">
            <h2>Key Points</h2>
            <ul>
              {result.keyPoints.map((point, index) => (
                <li key={index}>{point}</li>
              ))}
            </ul>
          </div>

          {editingActionIndex !== null && (
            <div className="card">
              <h2>Edit Action Item</h2>

              <input
                type="text"
                placeholder="Task"
                value={editTask}
                onChange={(e) => setEditTask(e.target.value)}
              />

              <input
                type="text"
                placeholder="Assigned To"
                value={editAssignedTo}
                onChange={(e) => setEditAssignedTo(e.target.value)}
              />

              <input
                type="text"
                placeholder="Deadline"
                value={editDeadline}
                onChange={(e) => setEditDeadline(e.target.value)}
              />

              <select
                value={editPriority}
                onChange={(e) => setEditPriority(e.target.value)}
              >
                <option value="High">High</option>
                <option value="Medium">Medium</option>
                <option value="Low">Low</option>
              </select>

              <button onClick={saveEditedActionItem}>Save Changes</button>

              <button
                className="clear-btn"
                onClick={() => setEditingActionIndex(null)}
              >
                Cancel
              </button>
            </div>
          )}

          <div className="card">
            <h2>Action Items</h2>

            {/* Phase 1 inc-2: add a new action item to this meeting */}
            <div
              className="card"
              style={{
                marginBottom: "15px",
                padding: "12px",
                background: darkMode ? "#1a2238" : "#f0f7ff",
              }}
            >
              <h3 style={{ margin: "0 0 10px 0" }}>Add Action Item</h3>
              <form
                onSubmit={addActionItem}
                style={{
                  display: "flex",
                  gap: "10px",
                  flexWrap: "wrap",
                  alignItems: "flex-end",
                }}
              >
                <div style={{ flex: 2, minWidth: "180px" }}>
                  <label>
                    <strong>Task *</strong>
                  </label>
                  <input
                    type="text"
                    placeholder="e.g., Review the API documentation"
                    value={newTask}
                    onChange={(e) => setNewTask(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "8px",
                      boxSizing: "border-box",
                      marginTop: "4px",
                    }}
                  />
                </div>
                <div style={{ flex: 1, minWidth: "140px" }}>
                  <label>
                    <strong>Assigned To</strong>
                  </label>
                  <input
                    type="text"
                    placeholder="Name"
                    value={newAssignedTo}
                    onChange={(e) => setNewAssignedTo(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "8px",
                      boxSizing: "border-box",
                      marginTop: "4px",
                    }}
                  />
                </div>
                <div style={{ flex: 1, minWidth: "140px" }}>
                  <label>
                    <strong>Deadline</strong>
                  </label>
                  <input
                    type="text"
                    placeholder="2026-10-05 or by Friday"
                    value={newDeadline}
                    onChange={(e) => setNewDeadline(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "8px",
                      boxSizing: "border-box",
                      marginTop: "4px",
                    }}
                  />
                </div>
                <div style={{ flex: 1, minWidth: "120px" }}>
                  <label>
                    <strong>Priority</strong>
                  </label>
                  <select
                    value={newPriority}
                    onChange={(e) => setNewPriority(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "8px",
                      boxSizing: "border-box",
                      marginTop: "4px",
                    }}
                  >
                    <option value="Low">Low</option>
                    <option value="Medium">Medium</option>
                    <option value="High">High</option>
                  </select>
                </div>
                <button type="submit" style={{ height: "36px" }}>
                  Add Action Item
                </button>
              </form>
            </div>

            <div className="filter-box">
              <label>Filter Action Items:</label>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="All">All</option>
                <option value="Pending">Pending</option>
                <option value="Completed">Completed</option>
                <option value="High Priority">High Priority</option>
              </select>
            </div>

            <table>
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Assigned To</th>
                  <th>Deadline</th>
                  <th>Priority</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredActionItems.map((item) => (
                  <tr key={item.originalIndex}>
                    <td>{item.task}</td>
                    <td>{item.assignedTo}</td>
                    <td>
                      {item.deadline}
                      {isOverdueLocal(item.deadline, item.status) && (
                        <span
                          className="priority-badge priority-high"
                          style={{
                            marginLeft: "8px",
                            padding: "3px 10px",
                            minWidth: "auto",
                            fontSize: "11px",
                          }}
                        >
                          Overdue
                        </span>
                      )}
                    </td>
                    <td>
                      <span
                        className={`priority-badge ${
                          item.priority === "High"
                            ? "priority-high"
                            : item.priority === "Medium"
                            ? "priority-medium"
                            : "priority-low"
                        }`}
                      >
                        {item.priority}
                      </span>
                    </td>
                    <td>
                      <select
                        value={item.status || "Pending"}
                        onChange={(e) =>
                          updateActionStatus(
                            result._id,
                            item.originalIndex,
                            e.target.value
                          )
                        }
                      >
                        <option value="Pending">Pending</option>
                        <option value="Completed">Completed</option>
                      </select>
                    </td>
                    <td>
                      <button
                        onClick={() =>
                          startEditActionItem(item, item.originalIndex)
                        }
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => deleteActionItem(item.originalIndex)}
                        className="delete-btn"
                        style={{ marginLeft: "8px" }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {filteredActionItems.length === 0 && (
              <p>No action items found for selected filter.</p>
            )}

            <div className="card" style={{ marginTop: "20px", border: "1px dashed #007bff" }}>
              <h2>AI Follow-up Email Generator</h2>
              <p>Generate a professional follow-up email draft based on this meeting's summary and action items.</p>

              <button onClick={generateEmailDraft} style={{ marginBottom: "15px" }}>
                Generate Follow-up Email
              </button>

              {emailDraft && (
                <div>
                  <textarea
                    rows="8"
                    value={emailDraft}
                    onChange={(e) => setEmailDraft(e.target.value)}
                    style={{ width: "100%", marginBottom: "10px", padding: "10px" }}
                  ></textarea>
                  <button onClick={copyEmailDraft}>Copy Email Draft</button>
                </div>
              )}
            </div>

            <div style={{ marginTop: "20px" }}>
              <button onClick={downloadReport}>Download PDF Report</button>
              <button onClick={printReport} style={{ marginLeft: "10px" }}>Print Report</button>
            </div>

            <div className="export-buttons">
              <button onClick={downloadTXT}>Download TXT</button>
              <button onClick={downloadJSON}>Download JSON</button>
              <button onClick={downloadCSV}>Download CSV</button>
            </div>

            <div className="card chat-card" style={{ marginTop: "20px" }}>
              <h2>Chat with Meeting</h2>
              <p>Ask questions about the transcript, decisions, or action items.</p>

              <div
                className="chat-box"
                style={{
                  maxHeight: "300px",
                  overflowY: "auto",
                  marginBottom: "15px",
                  padding: "10px",
                  background: darkMode ? "#1e1e1e" : "#f9f9f9",
                  borderRadius: "8px",
                }}
              >
                {chatMessages.length === 0 ? (
                  <p style={{ color: "#888", textAlign: "center" }}>
                    No messages yet. Ask something about this meeting!
                  </p>
                ) : (
                  chatMessages.map((msg, index) => (
                    <div
                      key={index}
                      style={{
                        margin: "10px 0",
                        textAlign: msg.sender === "user" ? "right" : "left",
                      }}
                    >
                      <span
                        style={{
                          display: "inline-block",
                          padding: "8px 12px",
                          borderRadius: "12px",
                          background:
                            msg.sender === "user"
                              ? "#007bff"
                              : darkMode
                              ? "#333"
                              : "#e2e8f0",
                          color:
                            msg.sender === "user"
                              ? "#fff"
                              : darkMode
                              ? "#fff"
                              : "#000",
                          maxWidth: "80%",
                        }}
                      >
                        {msg.text}
                      </span>
                    </div>
                  ))
                )}
                {chatLoading && (
                  <p style={{ fontStyle: "italic", color: "#888" }}>
                    AI is thinking...
                  </p>
                )}
              </div>

              {/* Phase P11: honest per-response chat source label */}
              {chatAiSource && (
                <p style={{ fontSize: "11px", color: "#888", margin: "0 0 10px 0", textAlign: "center" }}>
                  {chatAiSource === "llm"
                    ? "✨ answered by AI (Groq)"
                    : chatAiSource === "rule-based"
                      ? "(answered by rule-based search)"
                      : null}
                </p>
              )}

              <div style={{ display: "flex", gap: "10px" }}>
                <input
                  type="text"
                  placeholder="e.g., What was the deadline for the frontend task?"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyPress={(e) => e.key === "Enter" && sendChatMessage()}
                  style={{ flex: 1, padding: "10px" }}
                />
                <button onClick={sendChatMessage} disabled={chatLoading}>
                  Send
                </button>
              </div>
            </div>
          </div>

          {/* W3-G: rule-based suggested action items for this meeting */}
          {suggestions.length > 0 && (
            <div className="card">
              <h2>
                Suggested action items{" "}
                <span className="tiny-muted">(rule-based)</span>
              </h2>
              {suggestions.map((s, i) => {
                const text = s.text ?? s;
                return (
                  <div key={i} className="suggestion-row">
                    <span style={{ flex: 1 }}>{text}</span>
                    <button
                      className="clear-btn"
                      onClick={() => addSuggestedActionItem(text)}
                    >
                      Add
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="card" style={{ marginTop: "20px" }}>
        <h2>Meeting History & Advanced Filters</h2>

        <input
          id="history-search"
          type="text"
          placeholder="Search meetings by title, summary or category..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="search-input"
          style={{ marginBottom: "15px" }}
        />

        {search && (
          <button onClick={() => setSearch("")} className="clear-btn" style={{ marginBottom: "15px" }}>
            Clear Search
          </button>
        )}

        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginTop: "10px" }}>
          <div className="filter-box" style={{ flex: 1, minWidth: "200px" }}>
            <label>Filter by Category:</label>
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
            >
              <option value="All Categories">All Categories</option>
              <option value="General">General</option>
              <option value="Project">Project</option>
              <option value="College">College</option>
              <option value="Client">Client</option>
              <option value="Personal">Personal</option>
              <option value="Urgent">Urgent</option>
            </select>
          </div>

          <div className="filter-box" style={{ flex: 1, minWidth: "200px" }}>
            <label>Filter by Tag:</label>
            <select
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
            >
              <option value="All Tags">All Tags</option>
              {allUniqueTags.map((tag, idx) => (
                <option key={idx} value={tag}>{tag}</option>
              ))}
            </select>
          </div>

          <div className="filter-box" style={{ flex: 1, minWidth: "200px" }}>
            <label>Filter by Date:</label>
            <select
              value={dateFilter}
              onChange={(e) => setDateFilter(e.target.value)}
            >
              <option value="All Meetings">All Meetings</option>
              <option value="Today">Today</option>
              <option value="This Week">This Week</option>
              <option value="This Month">This Month</option>
            </select>
          </div>

          <div className="filter-box" style={{ flex: 1, minWidth: "200px" }}>
            <label>Sort Meetings:</label>
            <select
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
            >
              <option value="Newest First">Newest First</option>
              <option value="Oldest First">Oldest First</option>
              <option value="Title A-Z">Title A-Z</option>
              <option value="Title Z-A">Title Z-A</option>
            </select>
          </div>
        </div>

        {filteredHistory.length === 0 ? (
          <p style={{ marginTop: "15px" }}>No matching meetings found.</p>
        ) : (
          filteredHistory.map((meeting) => (
            <div className="history-item" key={meeting._id} style={{ borderBottom: "1px solid #ccc", padding: "15px 0" }}>
              <div>
                <h3>
                  {meeting.title}
                  {/* W3-E: rule-based sentiment badge */}
                  {meeting.sentiment?.label && (
                    <span className="sentiment-badge">
                      {meeting.sentiment.label === "Positive"
                        ? "😊"
                        : meeting.sentiment.label === "Negative"
                          ? "😟"
                          : "😐"}{" "}
                      {meeting.sentiment.label}{" "}
                      <span className="tiny-muted">Rule-based</span>
                    </span>
                  )}
                </h3>
                <p>
                  <strong>Category:</strong> {meeting.category || "General"} |{" "}
                  <strong>Tags:</strong> {meeting.tags && meeting.tags.length > 0 ? meeting.tags.join(", ") : "None"}
                </p>
                <p>{new Date(meeting.createdAt).toLocaleString()}</p>
                <p>{meeting.summary}</p>
              </div>

              <div className="history-buttons" style={{ marginTop: "10px" }}>
                <button onClick={() => viewMeeting(meeting)}>View</button>
                <button
                  onClick={() => deleteMeeting(meeting._id)}
                  className="delete-btn"
                  style={{ marginLeft: "10px" }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>
      </>
      ) : view === "kanban" ? (
      kanbanView
      ) : (
      decisionsView
      )}

      {/* W3: global overlays — tour, shortcuts dialog, email dialog */}
      {tourOverlay}
      {shortcutsDialog}
      {emailDialog}
    </div>
  );
}

export default App;

// Real-time layer for the AI Meeting Intelligence & Productivity Platform.
//
// Standalone module: wired into backend/server.js by another worker via:
//
//   let io = null;
//   try {
//     const { initRealtime } = require("./services/realtime");
//     io = initRealtime(server, { JWT_SECRET, Meeting, findReadableMeeting, ACTION_STATUSES, ACTION_PRIORITIES });
//   } catch (e) {
//     console.error("[realtime] socket.io unavailable — real-time features disabled:", e.message);
//   }
//
// Never crashes the process: all per-socket errors are logged server-side only.

const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");

const room = (id) => "meeting:" + String(id);

function initRealtime(server, deps) {
  const { JWT_SECRET, Meeting, findReadableMeeting, ACTION_STATUSES, ACTION_PRIORITIES } = deps || {};

  const io = new Server(server, {
    cors: {
      origin: process.env.CORS_ORIGIN || "http://localhost:5173",
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  // ---- JWT auth ------------------------------------------------------------
  io.use((socket, next) => {
    const t = socket.handshake.auth && socket.handshake.auth.token;
    if (!t) return next(new Error("missing token"));
    try {
      const p = jwt.verify(t, JWT_SECRET);
      socket.userId = p.userId || p.id;
      if (!socket.userId) return next(new Error("bad token"));
      next();
    } catch (e) {
      next(new Error("invalid token"));
    }
  });

  // ---- Presence ------------------------------------------------------------
  const presence = new Map(); // meetingId -> Set(userId)

  function emitPresence(meetingId) {
    const set = presence.get(String(meetingId));
    io.to(room(meetingId)).emit("presence", {
      meetingId,
      count: set ? set.size : 0,
    });
  }

  function trackJoin(meetingId, userId) {
    const key = String(meetingId);
    let set = presence.get(key);
    if (!set) {
      set = new Set();
      presence.set(key, set);
    }
    set.add(String(userId));
    return set;
  }

  function trackLeave(userId) {
    const uid = String(userId);
    const affected = [];
    for (const [key, set] of presence.entries()) {
      if (set.delete(uid)) affected.push(key);
      if (set.size === 0) presence.delete(key);
    }
    return affected;
  }

  // ---- Socket handlers -----------------------------------------------------
  io.on("connection", (socket) => {
    socket.on("join-meeting", async ({ meetingId } = {}) => {
      try {
        const r = await findReadableMeeting(meetingId, socket.userId);
        if (!r) return socket.emit("error-message", { message: "Meeting not found" });
        socket.join(room(meetingId));
        trackJoin(meetingId, socket.userId);
        emitPresence(meetingId);
      } catch (e) {
        console.error("[realtime] join-meeting failed:", e && e.message);
        socket.emit("error-message", { message: "Join failed" });
      }
    });

    socket.on("notes:update", async ({ meetingId, manualNotes } = {}) => {
      try {
        const r = await findReadableMeeting(meetingId, socket.userId);
        if (!r) return;
        if (typeof manualNotes !== "string" || manualNotes.length > 10000) return;
        const m = r.meeting;
        m.manualNotes = manualNotes;
        await m.save();
        socket.to(room(meetingId)).emit("notes:update", {
          meetingId,
          manualNotes,
          updatedBy: socket.userId,
        });
      } catch (e) {
        console.error("[realtime] notes:update failed:", e && e.message);
      }
    });

    socket.on("action-item:update", async ({ meetingId, index, patch } = {}) => {
      try {
        const r = await findReadableMeeting(meetingId, socket.userId);
        if (!r) return;
        const m = r.meeting;
        const i = Number(index);
        if (!Number.isInteger(i) || i < 0 || i >= m.actionItems.length) return;
        const item = m.actionItems[i];
        const p = patch || {};
        if (p.status !== undefined) {
          if (!ACTION_STATUSES.includes(p.status)) return;
          item.status = p.status;
        }
        if (p.priority !== undefined) {
          if (!ACTION_PRIORITIES.includes(p.priority)) return;
          item.priority = p.priority;
        }
        if (p.task !== undefined) {
          if (typeof p.task !== "string" || !p.task.trim() || p.task.length > 500) return;
          item.task = p.task.trim();
        }
        if (p.assignedTo !== undefined) item.assignedTo = String(p.assignedTo).slice(0, 100);
        if (p.deadline !== undefined) item.deadline = String(p.deadline).slice(0, 100);
        await m.save();
        io.to(room(meetingId)).emit("action-item:update", {
          meetingId,
          index: i,
          item: item.toObject ? item.toObject() : item,
        });
      } catch (e) {
        console.error("[realtime] action-item:update failed:", e && e.message);
      }
    });

    socket.on("disconnect", () => {
      try {
        const affected = trackLeave(socket.userId);
        for (const meetingId of affected) emitPresence(meetingId);
      } catch (e) {
        console.error("[realtime] disconnect cleanup failed:", e && e.message);
      }
    });
  });

  return io;
}

module.exports = { initRealtime, room };

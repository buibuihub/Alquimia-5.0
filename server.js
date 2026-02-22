const express = require("express");
const cors = require("cors");
const path = require("path");
const Groq = require("groq-sdk");
require("dotenv").config();

const app = express();

// ─── Middleware ───────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "4mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ─── Groq Client ─────────────────────────────────────────
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// ─── In-memory stores ─────────────────────────────────────
// chats[sessionId] = { title, messages: [], created, updated }
const chats = {};

// ─── Helpers ──────────────────────────────────────────────

/** Generate a short title from the first user message */
function makeTitle(message) {
  return message.trim().slice(0, 60) + (message.length > 60 ? "…" : "");
}

/** Strip provider/model mentions from AI response */
function sanitize(text) {
  return text
    .replace(/\bgroq\b/gi, "")
    .replace(/\bllama\b/gi, "")
    .replace(/\bmeta\b/gi, "")
    .replace(/\bopenai\b/gi, "")
    .replace(/\bgoogle\b/gi, "")
    .replace(/\banthropicl\b/gi, "")
    .replace(/\bmistral\b/gi, "")
    .replace(/\bgpt-?[0-9]*/gi, "")
    .replace(/\blanguage model\b/gi, "assistant")
    .replace(/\bAI model\b/gi, "assistant")
    .trim();
}

/** Allowed models */
const ALLOWED_MODELS = [
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "meta-llama/llama-4-maverick-17b-128e-instruct",
  "moonshotai/kimi-k2-instruct",
];
const DEFAULT_MODEL = "llama-3.3-70b-versatile";

// ─── Routes ───────────────────────────────────────────────

/**
 * GET /sessions
 * Returns list of all sessions (id, title, updated, messageCount)
 */
app.get("/sessions", (req, res) => {
  const list = Object.entries(chats)
    .map(([id, chat]) => ({
      id,
      title: chat.title || "New chat",
      updated: chat.updated || chat.created,
      created: chat.created,
      messageCount: chat.messages.filter((m) => m.role !== "system").length,
    }))
    .sort((a, b) => new Date(b.updated) - new Date(a.updated));

  res.json(list);
});

/**
 * DELETE /sessions
 * Clear all sessions
 */
app.delete("/sessions", (req, res) => {
  Object.keys(chats).forEach((k) => delete chats[k]);
  res.json({ ok: true });
});

/**
 * GET /history/:id
 * Returns full message history for a session
 */
app.get("/history/:id", (req, res) => {
  const chat = chats[req.params.id];
  if (!chat) return res.json([]);

  const msgs = chat.messages.map((m) => ({
    role: m.role,
    content: m.content,
    timestamp: m.timestamp,
  }));

  res.json(msgs);
});

/**
 * DELETE /session/:id
 * Delete a single session
 */
app.delete("/session/:id", (req, res) => {
  delete chats[req.params.id];
  res.json({ ok: true });
});

/**
 * PATCH /session/:id
 * Rename a session
 */
app.patch("/session/:id", (req, res) => {
  const { id } = req.params;
  const { title } = req.body;

  if (!chats[id]) return res.status(404).json({ error: "Session not found" });
  if (title && typeof title === "string") {
    chats[id].title = title.trim().slice(0, 80);
  }

  res.json({ ok: true, title: chats[id].title });
});

/**
 * POST /ask
 * Main chat endpoint
 */
app.post("/ask", async (req, res) => {
  const {
    message,
    session,
    model: requestedModel,
    temperature = 0.7,
    max_tokens = 1024,
    system,
    top_p = 0.9,
  } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ answer: "Empty message" });
  }

  const sessionId = session || Date.now().toString();
  const model = ALLOWED_MODELS.includes(requestedModel) ? requestedModel : DEFAULT_MODEL;

  // Init session if new
  if (!chats[sessionId]) {
    const defaultSystem =
      system ||
      "You are Buibui AI, a highly capable, private AI assistant. Never mention model names, companies, providers, training sources, APIs, or that you are an AI model built on any external system. If asked who you are, say you are Buibui AI, created exclusively for this platform. Be helpful, precise, creative, and thorough. Format responses with markdown when appropriate.";

    chats[sessionId] = {
      title: makeTitle(message),
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      messages: [{ role: "system", content: defaultSystem }],
    };
  }

  // Update system prompt if provided
  if (system && chats[sessionId].messages[0]?.role === "system") {
    chats[sessionId].messages[0].content = system;
  }

  // Add user message
  const userMsg = {
    role: "user",
    content: message.trim(),
    timestamp: new Date().toISOString(),
  };
  chats[sessionId].messages.push(userMsg);
  chats[sessionId].updated = new Date().toISOString();

  // Build messages for API (strip timestamps — Groq doesn't accept extra fields)
  const apiMessages = chats[sessionId].messages.map(({ role, content }) => ({
    role,
    content,
  }));

  try {
    const completion = await groq.chat.completions.create({
      model,
      messages: apiMessages,
      temperature: Math.min(2, Math.max(0, parseFloat(temperature) || 0.7)),
      max_tokens: Math.min(8192, Math.max(64, parseInt(max_tokens) || 1024)),
      top_p: Math.min(1, Math.max(0, parseFloat(top_p) || 0.9)),
    });

    let reply =
      completion?.choices?.[0]?.message?.content || "I couldn't generate a response.";

    reply = sanitize(reply);

    const assistantMsg = {
      role: "assistant",
      content: reply,
      timestamp: new Date().toISOString(),
      model,
      usage: completion.usage || null,
    };

    chats[sessionId].messages.push(assistantMsg);
    chats[sessionId].updated = new Date().toISOString();

    res.json({
      answer: reply,
      session: sessionId,
      title: chats[sessionId].title,
      model,
      usage: completion.usage || null,
    });
  } catch (err) {
    console.error("GROQ ERROR:", err?.error || err.message || err);

    // Remove the user message that failed
    chats[sessionId].messages.pop();

    const errMsg =
      err?.error?.message ||
      err?.message ||
      "An error occurred. Please try again.";

    res.status(500).json({
      answer: `⚠️ ${errMsg}`,
      session: sessionId,
    });
  }
});

/**
 * GET /stats
 * Basic server stats
 */
app.get("/stats", (req, res) => {
  const totalSessions = Object.keys(chats).length;
  const totalMessages = Object.values(chats).reduce(
    (acc, c) => acc + c.messages.filter((m) => m.role !== "system").length,
    0
  );
  res.json({ totalSessions, totalMessages, uptime: process.uptime() });
});

/**
 * POST /session/:id/clear
 * Clear messages in a session but keep the session
 */
app.post("/session/:id/clear", (req, res) => {
  const chat = chats[req.params.id];
  if (!chat) return res.status(404).json({ error: "Not found" });

  // Keep only system message
  chat.messages = chat.messages.filter((m) => m.role === "system");
  chat.updated = new Date().toISOString();

  res.json({ ok: true });
});

// ─── Catch-all → index.html ───────────────────────────────
app.use((req, res) => {
  res.sendFile(path.join(__dirname, "", "index.html"));
});

// ─── Start ────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════╗
  ║      🤖 Buibui AI Server              ║
  ║      Running on http://localhost:${PORT}  ║
  ╚═══════════════════════════════════════╝
  `);
});

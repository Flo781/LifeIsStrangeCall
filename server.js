const express = require("express");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const appRoot = __dirname;

// ---- HTTPS / HTTP ----
let server;
try {
  const key = fs.readFileSync(path.join(appRoot, "private-key.pem"));
  const cert = fs.readFileSync(path.join(appRoot, "certificate.pem"));
  server = https.createServer({ key, cert }, app);
  console.log("✓ HTTPS aktiv");
} catch {
  server = http.createServer(app);
  console.log("⚠ HTTP aktiv (kein Zertifikat gefunden)");
}

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
  pingInterval: 25000,
  pingTimeout: 60000,
});

// ---- Statische Dateien ----
app.use(express.static(path.join(appRoot, "public")));
app.use("/assets", express.static(path.join(appRoot, "assets")));

// ---- Warteraum ----
// Ein einziger globaler Raum für genau 2 Personen.
// users: Map(socketId -> { username, profilePic })
const waitingRoom = {
  name: "default",
  users: new Map()
};

// ---- Dead by Daylight Queue API ----
// Versucht mehrere API-Endpunkte falls einer nicht erreichbar ist.
const DBD_APIS = [
  "https://api.deadbyqueue.com",
  "https://api2.deadbyqueue.com",
];

async function fetchDbdQueue() {
  const headers = { "Accept": "application/json", "User-Agent": "Mozilla/5.0 LifeIsStrangeCall/1.5" };
  let lastErr = null;

  for (const base of DBD_APIS) {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 8000);
    try {
      const [rRes, qRes] = await Promise.all([
        fetch(`${base}/regions`, { signal: controller.signal, headers }),
        fetch(`${base}/queues`,  { signal: controller.signal, headers }),
      ]);
      clearTimeout(tid);
      if (!rRes.ok || !qRes.ok) continue;

      const regions = (await rRes.json())?.regions ?? {};
      const rawQ    = (await qRes.json())?.queues  ?? {};
      const mode    = ["live","live-event","ptb","ptb-event"].find(m => rawQ[m]) ?? Object.keys(rawQ)[0];
      if (!mode) continue;

      const rc        = "eu-central-1";
      const isOnline  = Boolean(regions[rc]);
      const killerRaw = rawQ[mode]?.[rc]?.killer?.time;

      let killerQueue;
      if (!isOnline)                              killerQueue = "Offline";
      else if (killerRaw == null || killerRaw === "x") killerQueue = "Keine Daten";
      else {
        const secs = parseInt(killerRaw, 10);
        killerQueue = isFinite(secs)
          ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`
          : "Unbekannt";
      }
      return { killerQueue, mode, regionCode: rc, region: "Frankfurt, DE" };
    } catch (e) {
      clearTimeout(tid);
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("Alle APIs nicht erreichbar");
}

app.get("/api/killer-queue", async (_req, res) => {
  try {
    const data = await fetchDbdQueue();
    res.json(data);

  } catch (err) {
    const msg = err?.name === "AbortError" ? "Timeout (API nicht erreichbar)" : (err?.message ?? "Fehler");
    res.status(500).json({ error: msg });
  }
});

// ---- Status API (Debug) ----
app.get("/api/status", (_req, res) => {
  res.json({
    version: "1.5.0",
    waitingRoom: waitingRoom.users.size,
    users: Array.from(waitingRoom.users.values()).map(u => u.username)
  });
});

// ---- Socket.IO ----
io.on("connection", (socket) => {
  console.log("✓ Verbunden:", socket.id);
  socket.inCall = false;

  // Direkt verbinden — kein Code nötig
  socket.on("connect-to-call", ({ username, profilePic }) => {
    if (waitingRoom.users.size >= 2) {
      socket.emit("call-error", { message: "Bereits 2 Personen im Call. Bitte warte oder versuche es später." });
      return;
    }

    waitingRoom.users.set(socket.id, { username, profilePic });
    socket.inCall = true;
    socket.join(waitingRoom.name);

    const userCount = waitingRoom.users.size;
    console.log(`✓ ${username} verbunden (${userCount}/2)`);

    const userList = Array.from(waitingRoom.users.entries()).map(([id, u]) => ({
      id, username: u.username, profilePic: u.profilePic
    }));

    // Bestätigung an den neuen User
    socket.emit("call-joined", {
      users: userList,
      isFirst: userCount === 1   // true = erste Person (wird später Host)
    });

    // Den anderen informieren dass jemand beigetreten ist
    if (userCount === 2) {
      socket.to(waitingRoom.name).emit("peer-joined", { id: socket.id, username, profilePic });
    }
  });

  // WebRTC Signaling — nur innerhalb des Calls
  socket.on("signal", (data) => {
    if (socket.inCall) {
      socket.to(waitingRoom.name).emit("signal", data);
    }
  });

  // Chat
  socket.on("chat-message", (text) => {
    if (!socket.inCall) return;
    const user = waitingRoom.users.get(socket.id);
    if (!user) return;
    io.to(waitingRoom.name).emit("chat-message", {
      id: socket.id,
      username: user.username,
      text: String(text).slice(0, 500),
      time: new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })
    });
  });

  // Screen Share gestoppt
  socket.on("screen-share-stopped", () => {
    if (socket.inCall) {
      socket.to(waitingRoom.name).emit("screen-share-stopped");
    }
  });

  // Disconnect
  socket.on("disconnect", () => {
    if (!socket.inCall) return;
    const user = waitingRoom.users.get(socket.id);
    if (user) {
      console.log(`✓ ${user.username} getrennt`);
      socket.to(waitingRoom.name).emit("peer-left", { id: socket.id, username: user.username });
    }
    waitingRoom.users.delete(socket.id);
    console.log(`✓ Call-Nutzer: ${waitingRoom.users.size}/2`);
  });

  socket.on("error", (err) => console.error("Socket-Fehler:", err));
});

// ---- Server starten ----
const host = "0.0.0.0";
const requestedPort = Number(process.env.PORT) || 3000;
const maxRetries = process.env.PORT ? 0 : 10;

function startServer(port, retriesLeft) {
  const onError = (err) => {
    if (err.code === "EADDRINUSE" && retriesLeft > 0) {
      server.off("error", onError);
      return startServer(port + 1, retriesLeft - 1);
    }
    console.error("✗ Server-Startfehler:", err.message);
    process.exit(1);
  };
  server.once("error", onError);
  server.listen(port, host, () => {
    server.off("error", onError);
    console.log(`✓ Server läuft auf Port ${port}`);
    console.log(`✓ Socket.IO aktiv`);
  });
}

startServer(requestedPort, maxRetries);

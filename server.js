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

// ---- Räume ----
// roomCode -> { users: Map(socketId -> { username, profilePic }) }
const rooms = new Map();

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// ---- Dead by Daylight Queue API (behalten) ----
const regionInfo = {
  "Europe": {
    "eu-central-1": { name: "Germany, Frankfurt" },
    "eu-west-1": { name: "Ireland, Dublin" },
    "eu-west-2": { name: "United Kingdom, London" }
  }
};

app.get("/api/killer-queue", async (req, res) => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const [regionsRes, queuesRes] = await Promise.all([
      fetch("https://api2.deadbyqueue.com/regions", {
        signal: controller.signal,
        headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" }
      }),
      fetch("https://api2.deadbyqueue.com/queues", {
        signal: controller.signal,
        headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" }
      })
    ]);

    clearTimeout(timeout);

    if (!regionsRes.ok || !queuesRes.ok) {
      return res.status(502).json({ error: "Upstream Fehler" });
    }

    const regionsData = await regionsRes.json();
    const queuesData = await queuesRes.json();

    const regions = regionsData?.regions || {};
    const queues = queuesData?.queues || {};
    const mode = ["live", "live-event", "ptb", "ptb-event"].find(m => queues[m]) || Object.keys(queues)[0];

    if (!mode) return res.status(500).json({ error: "Keine Queue-Modi" });

    const regionCode = "eu-central-1";
    const isOnline = Boolean(regions[regionCode]);
    const killerRaw = queues[mode]?.[regionCode]?.killer?.time ?? "x";

    let killerQueue;
    if (!isOnline || killerRaw === "x" || killerRaw == null) {
      killerQueue = isOnline ? "Fehler" : "Offline";
    } else {
      const val = parseInt(killerRaw, 10);
      if (!isFinite(val)) { killerQueue = "Unbekannt"; }
      else { killerQueue = `${Math.floor(val / 60)}:${String(val % 60).padStart(2, "0")}`; }
    }

    res.json({ killerQueue, mode, regionCode, region: "Germany, Frankfurt" });
  } catch (err) {
    res.status(500).json({ error: err?.name === "AbortError" ? "Timeout" : "Fehler" });
  }
});

// ---- Socket.IO ----
io.on("connection", (socket) => {
  console.log("✓ Verbunden:", socket.id);
  socket.currentRoom = null;

  // Raum erstellen (Host)
  socket.on("create-room", ({ username, profilePic }) => {
    let code;
    do { code = generateRoomCode(); } while (rooms.has(code));

    rooms.set(code, {
      users: new Map([[socket.id, { username, profilePic }]])
    });
    socket.currentRoom = code;
    socket.join(code);

    console.log(`✓ Raum ${code} erstellt von ${username}`);
    socket.emit("room-created", { roomCode: code });
  });

  // Raum beitreten (Gast)
  socket.on("join-room", ({ roomCode, username, profilePic }) => {
    const code = String(roomCode).toUpperCase().trim();
    const room = rooms.get(code);

    if (!room) {
      socket.emit("room-error", { message: "Raum nicht gefunden — Code überprüfen." });
      return;
    }
    if (room.users.size >= 2) {
      socket.emit("room-error", { message: "Raum ist voll (max. 2 Personen)." });
      return;
    }

    room.users.set(socket.id, { username, profilePic });
    socket.currentRoom = code;
    socket.join(code);

    console.log(`✓ ${username} ist Raum ${code} beigetreten`);

    const userList = Array.from(room.users.entries()).map(([id, u]) => ({
      id, username: u.username, profilePic: u.profilePic
    }));

    // Gast bekommt die Nutzerliste
    socket.emit("room-joined", { roomCode: code, users: userList });

    // Host erfährt dass Gast beigetreten ist
    socket.to(code).emit("peer-joined", { id: socket.id, username, profilePic });
  });

  // Raum-Code-Prüfung (optional, ohne beitreten)
  socket.on("check-room", ({ roomCode }) => {
    const code = String(roomCode).toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) { socket.emit("room-check-result", { exists: false }); return; }
    socket.emit("room-check-result", { exists: true, userCount: room.users.size });
  });

  // WebRTC Signaling — nur innerhalb des Raums
  socket.on("signal", (data) => {
    if (socket.currentRoom) {
      socket.to(socket.currentRoom).emit("signal", data);
    }
  });

  // Chat
  socket.on("chat-message", (text) => {
    if (!socket.currentRoom) return;
    const room = rooms.get(socket.currentRoom);
    const user = room?.users.get(socket.id);
    if (!user) return;
    io.to(socket.currentRoom).emit("chat-message", {
      id: socket.id,
      username: user.username,
      text: String(text).slice(0, 500),
      time: new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })
    });
  });

  // Screen Share gestoppt
  socket.on("screen-share-stopped", () => {
    if (socket.currentRoom) {
      socket.to(socket.currentRoom).emit("screen-share-stopped");
    }
  });

  // Disconnect
  socket.on("disconnect", () => {
    if (!socket.currentRoom) return;
    const room = rooms.get(socket.currentRoom);
    if (!room) return;

    const user = room.users.get(socket.id);
    if (user) {
      console.log(`✓ ${user.username} getrennt (${socket.currentRoom})`);
      socket.to(socket.currentRoom).emit("peer-left", {
        id: socket.id,
        username: user.username
      });
    }

    room.users.delete(socket.id);

    if (room.users.size === 0) {
      rooms.delete(socket.currentRoom);
      console.log(`✓ Raum ${socket.currentRoom} gelöscht (leer)`);
    }
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

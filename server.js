const express = require("express");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { Server } = require("socket.io");

const app = express();

// Pfad zum App-Verzeichnis — funktioniert sowohl im Dev-Modus als auch im gebauten Bundle
const isPackaged = process.resourcesPath && !process.resourcesPath.includes("node_modules");
const appRoot = isPackaged
  ? path.join(process.resourcesPath, "app")
  : __dirname;

const regionInfo = {
  "North America": {
    "us-east-1": { name: "USA, Virginia" },
    "us-east-2": { name: "USA, Ohio" },
    "us-west-1": { name: "USA, California" },
    "us-west-2": { name: "USA, Oregon" },
    "ca-central-1": { name: "Canada, Montréal" }
  },
  "Europe": {
    "eu-central-1": { name: "Germany, Frankfurt" },
    "eu-west-1": { name: "Ireland, Dublin" },
    "eu-west-2": { name: "United Kingdom, London" }
  },
  "Asia Pacific": {
    "ap-south-1": { name: "India, Mumbai" },
    "ap-east-1": { name: "China, Hong Kong" },
    "ap-northeast-1": { name: "Japan, Tokyo" },
    "ap-northeast-2": { name: "South Korea, Seoul" },
    "ap-southeast-1": { name: "Singapore" },
    "ap-southeast-2": { name: "Australia, Sydney" }
  },
  "South America": {
    "sa-east-1": { name: "Brazil, São Paulo" }
  }
};

const orderedGameModes = ["live", "live-event", "ptb", "ptb-event"];

function formatQueueTimeText(time, isOnline, gameMode) {
  if (!isOnline) return "Offline";

  if (time === "x" || time === null || time === undefined) {
    if (gameMode === "live" || gameMode === "live-event") return "Error";
    if (gameMode === "ptb" || gameMode === "ptb-event") return "Dead queue";
    return "Unknown";
  }

  const value = Number.parseInt(time, 10);
  if (!Number.isFinite(value)) return "Unknown";

  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function getRegionOrder() {
  const order = [];
  Object.keys(regionInfo).forEach((continent) => {
    Object.keys(regionInfo[continent]).forEach((regionCode) => {
      order.push(regionCode);
    });
  });
  return order;
}

function getRegionName(regionCode) {
  for (const continent of Object.keys(regionInfo)) {
    if (regionInfo[continent]?.[regionCode]?.name) return regionInfo[continent][regionCode].name;
  }
  return regionCode;
}

// HTTPS Setup (für Entwicklung - selbstsigniertes Zertifikat)
let server;
try {
  const key = fs.readFileSync(path.join(appRoot, "private-key.pem"));
  const cert = fs.readFileSync(path.join(appRoot, "certificate.pem"));
  server = https.createServer({ key, cert }, app);
  console.log("✓ HTTPS aktiviert");
} catch (err) {
  // Fallback zu HTTP für lokale Tests
  server = http.createServer(app);
  console.log("⚠ Nur HTTP verfügbar - getUserMedia könnte auf macOS/Safari fehlschlagen");
}

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: false
  },
  transports: ["websocket", "polling"],
  pingInterval: 25000,
  pingTimeout: 60000
});

// Statische Dateien — Pfad relativ zum App-Root
app.use(express.static(path.join(appRoot, "public")));
app.use("/assets", express.static(path.join(appRoot, "assets")));

app.get("/api/killer-queue", async (req, res) => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const [regionsResponse, queuesResponse] = await Promise.all([
      fetch("https://api2.deadbyqueue.com/regions", {
        signal: controller.signal,
        headers: {
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"
        }
      }),
      fetch("https://api2.deadbyqueue.com/queues", {
        signal: controller.signal,
        headers: {
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"
        }
      })
    ]);

    clearTimeout(timeout);

    if (!regionsResponse.ok || !queuesResponse.ok) {
      return res.status(502).json({
        error: `Upstream Fehler: regions=${regionsResponse.status}, queues=${queuesResponse.status}`
      });
    }

    const regionsData = await regionsResponse.json();
    const queuesData = await queuesResponse.json();

    const regions = regionsData?.regions || {};
    const queues = queuesData?.queues || {};
    const mode = orderedGameModes.find((item) => queues[item]) || Object.keys(queues)[0];

    if (!mode) {
      return res.status(500).json({ error: "Keine Queue-Modi verfügbar" });
    }

    const regionOrder = getRegionOrder();
    const regionCode = regionOrder[5];

    if (!regionCode) {
      return res.status(500).json({ error: "Region für XPath-Zeile 6 nicht gefunden" });
    }

    const isOnline = Boolean(regions[regionCode]);
    const killerRaw = queues[mode]?.[regionCode]?.killer?.time ?? "x";
    const killerQueue = formatQueueTimeText(killerRaw, isOnline, mode);

    if (!killerQueue) {
      return res.status(500).json({ error: "Killer Queue konnte nicht ausgelesen werden" });
    }

    res.json({
      killerQueue,
      mode,
      regionCode,
      region: getRegionName(regionCode)
    });
  } catch (error) {
    const message = error?.name === "AbortError"
      ? "Timeout beim Laden von deadbyqueue"
      : "Fehler beim Laden der Killer Queue";
    res.status(500).json({ error: message });
  }
});

// Socket.IO Events Debug Logging
io.use((socket, next) => {
  console.log("Socket.IO verbindungsversuch von:", socket.id);
  next();
});

// Nutzer speichern (id -> {username, profilePic})
const users = new Map();

io.on("connection", (socket) => {
  console.log("✓ User verbunden:", socket.id);

  // Nutzer registrieren
  socket.on("register", (data) => {
    const { username, profilePic } = data;
    users.set(socket.id, { username, profilePic });
    console.log(`✓ ${username} beigetreten`);
    
    // Allen mitteilen dass jemand beigetreten ist
    io.emit("user-joined", { id: socket.id, username, profilePic });
    
    // Nutzerliste senden
    const userList = Array.from(users.entries()).map(([id, userData]) => ({ 
      id, 
      username: userData.username,
      profilePic: userData.profilePic 
    }));
    io.emit("user-list", userList);
  });

  // WebRTC Signaling
  socket.on("signal", (data) => {
    socket.broadcast.emit("signal", data);
  });

  // Screen Share gestoppt
  socket.on("screen-share-stopped", () => {
    const userData = users.get(socket.id);
    const username = userData?.username || "Unbekannt";
    socket.broadcast.emit("screen-share-stopped", { id: socket.id, username });
  });

  // Chat Nachrichten
  socket.on("chat-message", (message) => {
    const userData = users.get(socket.id);
    const username = userData?.username || "Unbekannt";
    io.emit("chat-message", {
      id: socket.id,
      username,
      text: message,
      time: new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })
    });
  });

  // Call verlassen (ohne Socket zu trennen)
  socket.on("leave-call", () => {
    const userData = users.get(socket.id);
    if (userData) {
      console.log(`✓ ${userData.username} hat den Call verlassen`);
      io.emit("user-left", { id: socket.id, username: userData.username });
      users.delete(socket.id);
      
      // Aktualisierte Nutzerliste senden
      const userList = Array.from(users.entries()).map(([id, userData]) => ({ 
        id, 
        username: userData.username,
        profilePic: userData.profilePic 
      }));
      io.emit("user-list", userList);
    }
  });

  socket.on("disconnect", () => {
    const userData = users.get(socket.id);
    if (userData) {
      console.log(`✓ ${userData.username} getrennt`);
      io.emit("user-left", { id: socket.id, username: userData.username });
    }
    users.delete(socket.id);
    
    // Aktualisierte Nutzerliste senden
    const userList = Array.from(users.entries()).map(([id, userData]) => ({ 
      id, 
      username: userData.username,
      profilePic: userData.profilePic 
    }));
    io.emit("user-list", userList);
  });

  // Fehlerbehandlung
  socket.on("error", (error) => {
    console.error("Socket Fehler:", error);
  });
});

const host = "0.0.0.0";
const requestedPort = Number(process.env.PORT) || 3000;
const maxRetries = process.env.PORT ? 0 : 10;

function startServer(port, retriesLeft) {
  const onError = (error) => {
    if (error.code === "EADDRINUSE" && retriesLeft > 0) {
      const nextPort = port + 1;
      console.warn(`⚠ Port ${port} belegt, versuche Port ${nextPort}...`);
      server.off("error", onError);
      return startServer(nextPort, retriesLeft - 1);
    }

    if (error.code === "EADDRINUSE") {
      console.error(`✗ Port ${port} ist bereits belegt. Bitte Prozess beenden oder PORT setzen.`);
      process.exit(1);
    }

    console.error("✗ Server-Startfehler:", error.message);
    process.exit(1);
  };

  server.once("error", onError);
  server.listen(port, host, () => {
    server.off("error", onError);
    console.log(`✓ Server läuft auf Port ${port}`);
    console.log("✓ Socket.IO aktiv");
    console.log(`✓ Für externen Zugriff: ngrok http ${port}`);
  });
}

startServer(requestedPort, maxRetries);
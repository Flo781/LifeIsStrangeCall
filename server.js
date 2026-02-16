const express = require("express");
const https = require("https");
const http = require("http");
const fs = require("fs");
const { Server } = require("socket.io");

const app = express();

// HTTPS Setup (für Entwicklung - selbstsigniertes Zertifikat)
let server;
try {
  const key = fs.readFileSync("./private-key.pem");
  const cert = fs.readFileSync("./certificate.pem");
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

app.use(express.static("public"));
app.use("/assets", express.static("assets"));

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

server.listen(3000, "0.0.0.0", () => {
  console.log("✓ Server läuft auf Port 3000");
  console.log("✓ Socket.IO aktiv");
  console.log("✓ Für externen Zugriff: ngrok http 3000");
});
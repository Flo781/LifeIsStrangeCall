const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));
app.use("/assets", express.static("assets"));

// Nutzer speichern (id -> {username, profilePic})
const users = new Map();

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // Nutzer registrieren
  socket.on("register", (data) => {
    const { username, profilePic } = data;
    users.set(socket.id, { username, profilePic });
    console.log(`${username} joined`);
    
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
      console.log(`${userData.username} left the call`);
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
      console.log(`${userData.username} left`);
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
});

server.listen(3000, () => {
  console.log("Server läuft auf http://localhost:3000");
});
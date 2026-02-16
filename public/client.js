// client.js
const socket = io();

let localStream;
let peerConnection;
let screenStream;
let isMuted = false;
let statsInterval;
let username = "";
let userProfilePic = ""; // Profilbild URL
let participants = new Map(); // userId -> {username, tile, audio, profilePic}
let currentContextTarget = null; // Video/User container aktuell im Context Menu
let userAudioElements = new Map(); // userId -> audio element

// Profilbild-Zuordnung
const profilePictures = {
  "Sarah": "/assets/Profilbilder/images.jfif",
  "Flores": "/assets/Profilbilder/images (1).jfif"
};

// STUN/TURN Server für NAT Traversal
const configuration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject"
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject"
    }
  ]
};

// Flag um doppelte Renegotiation zu verhindern
let isNegotiating = false;

// ---- UI Elemente ----
const joinBtn = document.getElementById("joinBtn");
const muteBtn = document.getElementById("muteBtn");
const screenBtn = document.getElementById("screenBtn");
const statsBtn = document.getElementById("statsBtn");
const leaveBtn = document.getElementById("leaveBtn");
const stopScreenBtn = document.getElementById("stopScreenBtn");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const videoGrid = document.getElementById("videoGrid");
const emptyState = document.getElementById("emptyState");
const statsOverlay = document.getElementById("statsOverlay");

// Chat Elemente
const chatMessages = document.getElementById("chatMessages");
const chatInput = document.getElementById("chatInput");
const chatSend = document.getElementById("chatSend");

// Username Modal
const usernameModal = document.getElementById("usernameModal");
const profileOptions = document.querySelectorAll(".profile-option");

// Context Menu & Participants
const contextMenu = document.getElementById("contextMenu");
const participantsList = document.getElementById("participantsList");
const contextVolumeSlider = document.getElementById("contextVolumeSlider");
const contextVolumeLabel = document.getElementById("contextVolumeLabel");
const contextFullscreen = document.getElementById("contextFullscreen");

// ---- Profile Selection ----
profileOptions.forEach(option => {
  option.onclick = () => {
    username = option.dataset.name;
    userProfilePic = profilePictures[username] || "";
    usernameModal.classList.add("hidden");
    // Direkt Join ausführen nachdem Profil gewählt wurde
    joinBtn.click();
  };
});

// ---- Chat Funktionen ----
function addChatMessage(msg) {
  const div = document.createElement("div");
  div.className = "chat-message";
  div.innerHTML = `
    <div class="meta">
      <span class="username">${escapeHtml(msg.username)}</span>
      <span class="time">${msg.time}</span>
    </div>
    <div class="text">${escapeHtml(msg.text)}</div>
  `;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addSystemMessage(text) {
  const div = document.createElement("div");
  div.className = "chat-message system";
  div.innerHTML = `<div class="text">${escapeHtml(text)}</div>`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

chatSend.onclick = sendMessage;
chatInput.onkeypress = (e) => {
  if (e.key === "Enter") sendMessage();
};

function sendMessage() {
  const text = chatInput.value.trim();
  if (text.length < 1) return;
  socket.emit("chat-message", text);
  chatInput.value = "";
}

// Chat Empfangen
socket.on("chat-message", (msg) => {
  addChatMessage(msg);
});

socket.on("user-joined", (data) => {
  // Nur verarbeiten wenn wir im Call sind
  if (data.id !== socket.id && peerConnection) {
    addSystemMessage(`${data.username} ist beigetreten`);
    // User Tile erstellen für neuen User mit Profilbild
    createUserTile(data.id, data.username, false, data.profilePic);
  }
});

socket.on("user-left", (data) => {
  // Nur verarbeiten wenn wir im Call sind und es nicht wir selbst sind
  if (data.id !== socket.id && peerConnection) {
    addSystemMessage(`${data.username} hat den Call verlassen`);
    // User Tile entfernen
    removeUserTile(data.id);
  }
});

// ---- UI Update Funktionen ----
function updateConnectionStatus(connected) {
  statusDot.classList.toggle("connected", connected);
  statusText.textContent = connected ? "Verbunden" : "Nicht verbunden";
  muteBtn.disabled = !connected;
  screenBtn.disabled = !connected;
  leaveBtn.disabled = !connected;
  joinBtn.disabled = connected;
  
  if (connected) {
    joinBtn.classList.add("active");
    emptyState.style.display = "none";
  } else {
    joinBtn.classList.remove("active");
    emptyState.style.display = "flex";
  }
}

// ---- User Tile erstellen (Discord-Style) ----
function createUserTile(userId, name, isLocal = false, profilePic = "") {
  // Prüfen ob Tile schon existiert
  if (document.querySelector(`[data-user-id="${userId}"]`)) return;
  
  const tile = document.createElement("div");
  tile.className = "user-tile";
  tile.dataset.userId = userId;
  
  // Profilbild oder Initiale
  const avatarContent = profilePic 
    ? `<img src="${profilePic}" alt="${name}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">` 
    : name.charAt(0).toUpperCase();
  
  tile.innerHTML = `
    <div class="speaking-ring"></div>
    <div class="avatar">${avatarContent}</div>
    <div class="username">${escapeHtml(name)}${isLocal ? " (Du)" : ""}</div>
    <div class="status-icons">
      <div class="status-icon volume-icon">
        <svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>
      </div>
    </div>
  `;
  
  // Audio Element erstellen (versteckt)
  if (!isLocal) {
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.volume = 1;
    audio.dataset.userId = userId;
    document.body.appendChild(audio);
    userAudioElements.set(userId, audio);
    
    // Rechtsklick Context Menu
    tile.oncontextmenu = (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, tile, audio);
    };
  }
  
  // In participants Map speichern (mit profilePic)
  participants.set(userId, { username: name, tile, profilePic });
  
  videoGrid.appendChild(tile);
  emptyState.style.display = "none";
  
  return tile;
}

function removeUserTile(userId) {
  const tile = document.querySelector(`[data-user-id="${userId}"]`);
  if (tile) tile.remove();
  
  const audio = userAudioElements.get(userId);
  if (audio) {
    audio.remove();
    userAudioElements.delete(userId);
  }
  
  participants.delete(userId);
  
  // Empty State zeigen wenn keine User mehr
  if (videoGrid.children.length === 0 || 
      (videoGrid.children.length === 1 && videoGrid.contains(emptyState))) {
    emptyState.style.display = "flex";
  }
}

function createVideoContainer(stream, label, isLocal = false) {
  const container = document.createElement("div");
  container.className = "video-container";
  container.dataset.streamId = stream.id;
  
  const video = document.createElement("video");
  video.srcObject = stream;
  video.autoplay = true;
  video.playsInline = true;
  
  // Nur lokale Vorschau muten (kein Echo)
  if (isLocal) {
    video.muted = true;
  } else {
    video.muted = false;
    video.volume = 1;
  }
  
  const labelDiv = document.createElement("div");
  labelDiv.className = "label";
  labelDiv.innerHTML = `
    <div class="speaking-indicator"></div>
    <span>${escapeHtml(label)}</span>
    ${!isLocal ? '<span class="audio-hint">🔊</span>' : ''}
  `;
  
  // Rechtsklick Context Menu (nur für Remote)
  if (!isLocal) {
    container.oncontextmenu = (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, container, video);
    };
  }
  
  // Fullscreen Hint
  const hint = document.createElement("div");
  hint.className = "fullscreen-hint";
  hint.textContent = "Doppelklick für Vollbild";
  
  // Doppelklick für Vollbild
  container.ondblclick = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      container.requestFullscreen();
      video.muted = false;
      video.play().catch(() => {});
    }
  };
  
  container.appendChild(video);
  container.appendChild(labelDiv);
  container.appendChild(hint);
  videoGrid.appendChild(container);
  
  return container;
}

function removeVideoContainer(streamId) {
  const container = videoGrid.querySelector(`[data-stream-id="${streamId}"]`);
  if (container) container.remove();
}

// ---- Hilfsfunktion: PeerConnection erstellen ----
async function createPeerConnection() {
  if (peerConnection) return;

  peerConnection = new RTCPeerConnection(configuration);

  // ICE Candidate senden
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) socket.emit("signal", { candidate: event.candidate });
  };

  // Connection State überwachen
  peerConnection.onconnectionstatechange = () => {
    console.log("Connection state:", peerConnection.connectionState);
    if (peerConnection.connectionState === "connected") {
      updateConnectionStatus(true);
    } else if (peerConnection.connectionState === "disconnected" || 
               peerConnection.connectionState === "failed") {
      updateConnectionStatus(false);
    }
  };

  // Renegotiation Handler für neue Tracks (z.B. Screen Share)
  peerConnection.onnegotiationneeded = async () => {
    if (isNegotiating) return;
    isNegotiating = true;
    try {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      socket.emit("signal", { offer });
    } finally {
      isNegotiating = false;
    }
  };

  // Connection State änderungen
  peerConnection.onsignalingstatechange = () => {
    isNegotiating = peerConnection.signalingState !== "stable";
  };

  // Eingehende Tracks abspielen
  peerConnection.ontrack = (event) => {
    const stream = event.streams[0];
    
    // Prüfen ob Container schon existiert
    const existing = videoGrid.querySelector(`[data-stream-id="${stream.id}"]`);
    if (existing) return;
    
    const hasVideo = stream.getVideoTracks().length > 0;
    const hasAudio = stream.getAudioTracks().length > 0;
    
    if (hasVideo) {
      createVideoContainer(stream, "Remote Screen", false);
    }
    
    // Audio-Stream dem ersten Remote User zuweisen
    if (hasAudio && !hasVideo) {
      // Audio zu vorhandenem User-Tile zuweisen
      userAudioElements.forEach((audio, oderId) => {
        if (!audio.srcObject) {
          audio.srcObject = stream;
          console.log("Audio assigned to user:", oderId);
        }
      });
    }
    
    // Track Ende behandeln
    stream.onremovetrack = () => {
      if (stream.getTracks().length === 0) {
        removeVideoContainer(stream.id);
        const audio = document.querySelector(`audio[data-stream-id="${stream.id}"]`);
        if (audio) audio.remove();
      }
    };
  };
}

// ---- Join Button ----
joinBtn.onclick = async () => {
  if (peerConnection) return;
  
  // Username prüfen
  if (!username) {
    usernameModal.classList.remove("hidden");
    return;
  }

  try {
    // Mikrofon holen
    localStream = await navigator.mediaDevices.getUserMedia({ 
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    // PeerConnection erstellen
    await createPeerConnection();

    // Lokale Audio-Tracks hinzufügen
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
    
    // Eigene User-Tile erstellen mit Profilbild
    createUserTile(socket.id, username, true, userProfilePic);
    
    // Beim Server registrieren
    socket.emit("register", { username, profilePic: userProfilePic });
    addSystemMessage(`Du bist als "${username}" beigetreten`);
    
    updateConnectionStatus(true);
    startStatsUpdate();
    
  } catch (err) {
    console.error("Fehler beim Joinen:", err);
    alert("Konnte nicht beitreten: " + err.message);
  }
};

// ---- Mute Button ----
muteBtn.onclick = () => {
  if (!localStream) return;
  
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(track => {
    track.enabled = !isMuted;
  });
  
  muteBtn.classList.toggle("muted", isMuted);
  document.getElementById("muteIcon").innerHTML = isMuted 
    ? '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>'
    : '<path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z"/>';
};

// ---- Screen Share Button ----
screenBtn.onclick = async () => {
  if (!peerConnection) {
    alert("Zuerst Join klicken!");
    return;
  }

  try {
    // Bildschirm + Systemaudio holen mit hoher FPS
    screenStream = await navigator.mediaDevices.getDisplayMedia({ 
      video: {
        frameRate: { ideal: 60, max: 60 },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      }, 
      audio: {
        channelCount: 2,
        sampleRate: 48000,
        sampleSize: 16,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      },
      // System Audio bevorzugen (nicht Tab-Audio)
      systemAudio: "include",
      selfBrowserSurface: "exclude",
      surfaceSwitching: "include"
    });

    // Video Container für lokale Vorschau erstellen
    const container = createVideoContainer(screenStream, `${username}'s Screen (Vorschau)`, true);

    // Alle Tracks hinzufügen mit optimierten Encoding-Parametern
    screenStream.getTracks().forEach(track => {
      const sender = peerConnection.addTrack(track, screenStream);
      
      // Video Encoding optimieren
      if (track.kind === 'video') {
        const params = sender.getParameters();
        if (!params.encodings) params.encodings = [{}];
        params.encodings[0].maxBitrate = 8000000;
        params.encodings[0].maxFramerate = 60;
        sender.setParameters(params);
      }
      
      // Audio Encoding optimieren
      if (track.kind === 'audio') {
        const params = sender.getParameters();
        if (!params.encodings) params.encodings = [{}];
        params.encodings[0].maxBitrate = 320000;
        sender.setParameters(params);
      }
      
      track.onended = () => {
        peerConnection.removeTrack(sender);
        stopScreenShare();
      };
    });
    
    screenBtn.classList.add("active");
    screenBtn.style.display = "none";
    stopScreenBtn.style.display = "flex";
    
  } catch (err) {
    console.error("Screen Share Fehler:", err);
  }
};

// ---- Stop Screen Share Button ----
stopScreenBtn.onclick = () => {
  stopScreenShare();
};

function stopScreenShare() {
  if (!screenStream) return;
  
  const streamId = screenStream.id;
  
  // Alle Tracks stoppen
  screenStream.getTracks().forEach(track => track.stop());
  
  // Video Container entfernen
  removeVideoContainer(streamId);
  
  // Remote-User informieren, dass Stream gestoppt wurde
  socket.emit("screen-share-stopped", { streamId });
  
  screenStream = null;
  
  // Buttons zurücksetzen
  screenBtn.classList.remove("active");
  screenBtn.style.display = "flex";
  stopScreenBtn.style.display = "none";
}

// ---- Stats Button ----
statsBtn.onclick = () => {
  statsOverlay.classList.toggle("visible");
};

// ---- Leave Button ----
leaveBtn.onclick = () => {
  cleanup();
};

function cleanup() {
  // Server informieren, dass wir den Call verlassen (nur wenn wir im Call sind)
  if (peerConnection) {
    socket.emit("leave-call");
  }
  
  // Stats stoppen
  if (statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
  }
  
  // Streams stoppen
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  
  if (screenStream) {
    screenStream.getTracks().forEach(track => track.stop());
    screenStream = null;
  }
  
  // PeerConnection schließen
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  
  // Eigene User-Tile entfernen
  removeUserTile(socket.id);
  
  // Alle anderen User-Tiles entfernen
  videoGrid.querySelectorAll(".user-tile").forEach(el => el.remove());
  participants.clear();
  userAudioElements.forEach(audio => audio.remove());
  userAudioElements.clear();
  updateParticipantsList();
  
  // UI zurücksetzen
  updateConnectionStatus(false);
  videoGrid.querySelectorAll(".video-container").forEach(el => el.remove());
  document.querySelectorAll("audio[data-stream-id]").forEach(el => el.remove());
  screenBtn.classList.remove("active");
  screenBtn.style.display = "flex";
  stopScreenBtn.style.display = "none";
  muteBtn.classList.remove("muted");
  isMuted = false;
}

// ---- Stats Update ----
function startStatsUpdate() {
  statsInterval = setInterval(async () => {
    if (!peerConnection) return;
    
    const stats = await peerConnection.getStats();
    let resolution = "-";
    let fps = "-";
    let bitrate = "-";
    let rtt = "-";
    
    stats.forEach(report => {
      if (report.type === "outbound-rtp" && report.kind === "video") {
        resolution = `${report.frameWidth || 0}x${report.frameHeight || 0}`;
        fps = `${report.framesPerSecond || 0}`;
      }
      if (report.type === "candidate-pair" && report.state === "succeeded") {
        rtt = `${Math.round(report.currentRoundTripTime * 1000) || 0} ms`;
      }
      if (report.type === "outbound-rtp") {
        if (report.bytesSent && report.timestamp) {
          const br = Math.round((report.bytesSent * 8) / 1000);
          bitrate = `${br} kbps`;
        }
      }
    });
    
    document.getElementById("statRes").textContent = resolution;
    document.getElementById("statFps").textContent = fps;
    document.getElementById("statBitrate").textContent = bitrate;
    document.getElementById("statLatency").textContent = rtt;
    
  }, 1000);
}

// ---- Signaling Handler ----
socket.on("signal", async (data) => {
  if (data.offer) {
    // PeerConnection erstellen falls noch nicht vorhanden
    await createPeerConnection();
    
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));

    // eigenes Mikrofon hinzufügen, falls noch nicht vorhanden
    if (!localStream) {
      localStream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
      updateConnectionStatus(true);
      startStatsUpdate();
    }

    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit("signal", { answer });
  }

  if (data.answer && peerConnection) {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
  }

  if (data.candidate && peerConnection) {
    await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
  }
});

// ---- Cleanup bei Tab schließen ----
window.addEventListener("beforeunload", cleanup);

// ---- Screen Share Stop Event ----
socket.on("screen-share-stopped", (data) => {
  // Alle video containers durchsuchen und entfernen die zum Stream gehören
  const containers = videoGrid.querySelectorAll(".video-container");
  containers.forEach(container => {
    const video = container.querySelector("video");
    if (video && video.srcObject) {
      // Container entfernen (Stream ist bereits beendet)
      container.remove();
    }
  });
  
  // Auch versteckte Audio-Elemente entfernen
  document.querySelectorAll("audio[data-stream-id]").forEach(el => el.remove());
});

// ---- User List Update ----
socket.on("user-list", (users) => {
  // Nur verarbeiten wenn wir im Call sind
  if (!peerConnection) return;
  
  // Aktuelle User-IDs vom Server
  const serverUserIds = new Set(users.map(u => u.id));
  
  // User entfernen die nicht mehr im Call sind (außer uns selbst)
  participants.forEach((data, id) => {
    if (id !== socket.id && !serverUserIds.has(id)) {
      removeUserTile(id);
    }
  });
  
  users.forEach(user => {
    // User-Tiles für alle anderen User erstellen (falls noch nicht vorhanden)
    if (user.id !== socket.id) {
      if (!document.querySelector(`[data-user-id="${user.id}"]`)) {
        createUserTile(user.id, user.username, false, user.profilePic);
      }
    }
    // Participant Map aktualisieren
    if (!participants.has(user.id)) {
      participants.set(user.id, { username: user.username, profilePic: user.profilePic });
    }
  });
  updateParticipantsList();
});

function updateParticipantsList() {
  if (!participantsList) return;
  participantsList.innerHTML = "";
  
  participants.forEach((data, id) => {
    const item = document.createElement("div");
    item.className = "participant-item";
    const isMe = id === socket.id;
    const avatarContent = data.profilePic 
      ? `<img src="${data.profilePic}" alt="${data.username}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`
      : data.username.charAt(0).toUpperCase();
    item.innerHTML = `
      <div class="participant-avatar">${avatarContent}</div>
      <div class="participant-name">${escapeHtml(data.username)}${isMe ? " (Du)" : ""}</div>
      <div class="participant-status">🟢</div>
    `;
    participantsList.appendChild(item);
  });
}

// ---- Context Menu ----
function showContextMenu(x, y, container, video) {
  currentContextTarget = { container, video };
  
  // Position anpassen damit es nicht aus dem Bildschirm ragt
  const menuWidth = 200;
  const menuHeight = 150;
  
  if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth - 10;
  if (y + menuHeight > window.innerHeight) y = window.innerHeight - menuHeight - 10;
  
  contextMenu.style.left = x + "px";
  contextMenu.style.top = y + "px";
  contextMenu.classList.add("visible");
  
  // Volume Slider auf aktuellen Wert setzen
  const currentVolume = Math.round(video.volume * 100);
  contextVolumeSlider.value = currentVolume;
  contextVolumeLabel.textContent = currentVolume + "%";
}

function hideContextMenu() {
  contextMenu.classList.remove("visible");
  currentContextTarget = null;
}

// Klick außerhalb schließt Context Menu
document.addEventListener("click", (e) => {
  if (!contextMenu.contains(e.target)) {
    hideContextMenu();
  }
});

// Context Menu Event Handler
if (contextVolumeSlider) {
  contextVolumeSlider.oninput = () => {
    if (!currentContextTarget) return;
    const vol = contextVolumeSlider.value / 100;
    currentContextTarget.video.volume = vol;
    contextVolumeLabel.textContent = contextVolumeSlider.value + "%";
  };
}

if (contextFullscreen) {
  contextFullscreen.onclick = () => {
    if (!currentContextTarget) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      currentContextTarget.container.requestFullscreen();
      currentContextTarget.video.muted = false;
      currentContextTarget.video.play().catch(() => {});
    }
    hideContextMenu();
  };
}

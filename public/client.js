// client.js
const SERVER_URL = "https://lifeisstrange-production.up.railway.app";
const socket = io(SERVER_URL, {
  transports: ["websocket", "polling"],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
});

socket.on("connect", () => {
  console.log("✓ Socket.IO verbunden:", socket.id);
  // Auto-Rejoin wenn Verbindung wiederhergestellt wird
  if (username && peerConnection) {
    socket.emit("register", { username, profilePic: userProfilePic });
    addSystemMessage("🔄 Verbindung wiederhergestellt");
  }
});

socket.on("disconnect", (reason) => {
  console.log("✗ Socket.IO getrennt:", reason);
  updateConnectionStatus(false);
  if (peerConnection) {
    addSystemMessage("⚠️ Verbindung unterbrochen — versuche neu zu verbinden...");
  }
});

socket.on("connect_error", (error) => {
  console.error("✗ Socket.IO Verbindungsfehler:", error);
  alert("Verbindungsfehler zu Server: " + error.message);
});

socket.on("error", (error) => {
  console.error("✗ Socket.IO Fehler:", error);
});

let localStream;
let peerConnection;
let screenStream;
let isMuted = false;
let statsInterval;
let username = "";
let userProfilePic = ""; // Profilbild URL
let participants = new Map(); // userId -> {username, tile, audio, profilePic}
let currentContextTarget = null; // Video/User container aktuell im Context Menu
let userAudioElements = new Map(); // userId -> audio element (Mikrofon)
let remoteScreenStreams = new Map(); // streamId -> { container, audioEl }
let currentQuality = "medium"; // Stream Qualität: low, medium, high, ultra
let pendingAudioStreams = []; // Streams die ankamen bevor User-Tile existierte

// Qualitäts-Presets
const qualityPresets = {
  low:    { width: 1280, height: 720,  fps: 30, bitrate: 2500000,  label: "SD" },
  medium: { width: 1920, height: 1080, fps: 30, bitrate: 5000000,  label: "HD" },
  high:   { width: 1920, height: 1080, fps: 60, bitrate: 8000000,  label: "FHD" },
  ultra:  { width: 2560, height: 1440, fps: 60, bitrate: 12000000, label: "QHD" }
};

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

// ---- Opus HD Audio SDP Optimierung ----
function optimizeAudioSDP(sdp) {
  // Opus auf maximale Qualität setzen: Stereo, 510kbps, 48kHz
  sdp = sdp.replace(
    /a=fmtp:111 minptime=10;useinbandfec=1/g,
    'a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=510000;maxplaybackrate=48000;cbr=0'
  );
  // Fallback: Falls das Format leicht anders ist
  sdp = sdp.replace(
    /a=fmtp:111 minptime=10/g,
    'a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=510000;maxplaybackrate=48000;cbr=0'
  );
  return sdp;
}

// ---- UI Elemente ----
const joinBtn = document.getElementById("joinBtn");
const muteBtn = document.getElementById("muteBtn");
const screenBtn = document.getElementById("screenBtn");
const statsBtn = document.getElementById("statsBtn");
const queueBtn = document.getElementById("queueBtn");
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

// Quality Selector Elemente
const qualityBtn = document.getElementById("qualityBtn");
const qualityDropdown = document.getElementById("qualityDropdown");
const qualityBadge = document.getElementById("qualityBadge");
const qualityOptions = document.querySelectorAll(".quality-option");

// Username Modal
const usernameModal = document.getElementById("usernameModal");
const profileOptions = document.querySelectorAll(".profile-option");

// Context Menu & Participants
const contextMenu = document.getElementById("contextMenu");
const participantsList = document.getElementById("participantsList");
const contextVolumeSlider = document.getElementById("contextVolumeSlider");
const contextVolumeLabel = document.getElementById("contextVolumeLabel");
const contextFullscreen = document.getElementById("contextFullscreen");

// ---- Audio Geräte Auswahl ----
let selectedInputDeviceId = null;
let selectedOutputDeviceId = null;

const audioDeviceBtn = document.getElementById("audioDeviceBtn");
const audioDeviceModal = document.getElementById("audioDeviceModal");
const inputDeviceSelect = document.getElementById("inputDevice");
const outputDeviceSelect = document.getElementById("outputDevice");
const audioDeviceApply = document.getElementById("audioDeviceApply");
const audioDeviceCancel = document.getElementById("audioDeviceCancel");

audioDeviceBtn.onclick = async () => {
  // Geräteliste aktualisieren
  try {
    // Erstmal kurz getUserMedia anfragen damit Labels sichtbar werden
    await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {});
    const devices = await navigator.mediaDevices.enumerateDevices();

    inputDeviceSelect.innerHTML = "";
    outputDeviceSelect.innerHTML = '<option value="">Standard</option>';

    devices.forEach(device => {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent = device.label || `${device.kind} (${device.deviceId.slice(0, 8)})`;

      if (device.kind === "audioinput") {
        if (selectedInputDeviceId && device.deviceId === selectedInputDeviceId) {
          option.selected = true;
        }
        inputDeviceSelect.appendChild(option);
      } else if (device.kind === "audiooutput") {
        if (selectedOutputDeviceId && device.deviceId === selectedOutputDeviceId) {
          option.selected = true;
        }
        outputDeviceSelect.appendChild(option);
      }
    });

    audioDeviceModal.classList.remove("hidden");
  } catch (e) {
    alert("Fehler beim Laden der Audio-Geräte: " + e.message);
  }
};

audioDeviceCancel.onclick = () => {
  audioDeviceModal.classList.add("hidden");
};

audioDeviceApply.onclick = async () => {
  const newInputId = inputDeviceSelect.value;
  const newOutputId = outputDeviceSelect.value;
  audioDeviceModal.classList.add("hidden");

  // --- Eingabegerät wechseln ---
  if (newInputId && newInputId !== selectedInputDeviceId) {
    selectedInputDeviceId = newInputId;
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: newInputId },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
          channelCount: 2
        }
      });

      const newTrack = newStream.getAudioTracks()[0];

      // Alten Track stoppen und neuen in PeerConnection ersetzen
      if (localStream) {
        localStream.getAudioTracks().forEach(t => t.stop());
        localStream = newStream;

        if (peerConnection) {
          const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === "audio");
          if (sender) {
            await sender.replaceTrack(newTrack);
            console.log("Mikrofon live gewechselt ✓:", newTrack.label);
          }
        }
      } else {
        localStream = newStream;
      }

      addSystemMessage("🎤 Mikrofon geändert: " + newTrack.label);
    } catch (e) {
      alert("Eingabegerät konnte nicht gewechselt werden: " + e.message);
    }
  }

  // --- Ausgabegerät wechseln ---
  // setSinkId() wird von Electron/Chromium unterstützt
  if (newOutputId !== undefined) {
    selectedOutputDeviceId = newOutputId || null;

    // Alle Audio-Elemente auf neues Ausgabegerät setzen
    const allAudioElements = [
      ...document.querySelectorAll("audio"),
      ...document.querySelectorAll("video")
    ];

    for (const el of allAudioElements) {
      if (typeof el.setSinkId === "function") {
        try {
          await el.setSinkId(newOutputId || "");
          console.log("Ausgabegerät gesetzt:", el.tagName, newOutputId || "Standard");
        } catch (e) {
          console.warn("setSinkId fehlgeschlagen:", e.message);
        }
      }
    }

    if (newOutputId) {
      const label = outputDeviceSelect.options[outputDeviceSelect.selectedIndex]?.text || newOutputId;
      addSystemMessage("🔊 Ausgabe geändert: " + label);
    } else {
      addSystemMessage("🔊 Ausgabe auf Standard zurückgesetzt");
    }
  }
};

// Klick außerhalb schließt das Modal
audioDeviceModal.addEventListener("click", (e) => {
  if (e.target === audioDeviceModal) audioDeviceModal.classList.add("hidden");
});

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

// ---- Sound Effekte ----
function playJoinSound() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const now = ctx.currentTime;

  // Zwei aufsteigende Töne (Pling!)
  [440, 660].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, now + i * 0.15);
    gain.gain.setValueAtTime(0.25, now + i * 0.15);
    gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.15 + 0.4);
    osc.start(now + i * 0.15);
    osc.stop(now + i * 0.15 + 0.4);
  });
}

function playLeaveSound() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const now = ctx.currentTime;

  // Zwei absteigende Töne (Ploing!)
  [660, 440].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, now + i * 0.15);
    gain.gain.setValueAtTime(0.25, now + i * 0.15);
    gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.15 + 0.4);
    osc.start(now + i * 0.15);
    osc.stop(now + i * 0.15 + 0.4);
  });
}

socket.on("user-joined", (data) => {
  // Nur verarbeiten wenn wir im Call sind
  if (data.id !== socket.id && peerConnection) {
    playJoinSound();
    addSystemMessage(`${data.username} ist beigetreten`);
    // User Tile erstellen für neuen User mit Profilbild
    createUserTile(data.id, data.username, false, data.profilePic);
  }
});

socket.on("user-left", (data) => {
  // Nur verarbeiten wenn wir im Call sind und es nicht wir selbst sind
  if (data.id !== socket.id && peerConnection) {
    playLeaveSound();
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
      
    // Check ob bereits ein Fallback-Audio-Element vorhanden ist (ontrack kam vor createUserTile)
    const pendingAudio = document.querySelector('audio[data-pending-audio="true"]');
    if (pendingAudio && pendingAudio.srcObject) {
      audio.srcObject = pendingAudio.srcObject;
      audio.play().catch(e => console.warn("Audio play fehlgeschlagen:", e));
      pendingAudio.remove();
      console.log("Mikrofon-Audio von Fallback übernommen für User:", userId);
    }

    // Pending Audio-Stream zuweisen falls schon angekommen
    if (pendingAudioStreams.length > 0) {
      const stream = pendingAudioStreams.shift();
      audio.srcObject = stream;
      audio.play().catch(e => console.warn("Pending audio play:", e));
      console.log("Pending Audio → User:", userId);
    }
      
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
      // Video NICHT unmuten - Screen Share Audio läuft separat über audio Element
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
      addSystemMessage("✅ Verbunden!");
    } else if (peerConnection.connectionState === "disconnected") {
      addSystemMessage("⚠️ Verbindung kurz unterbrochen...");
    } else if (peerConnection.connectionState === "failed") {
      addSystemMessage("❌ Verbindung fehlgeschlagen — versuche neu...");
      // ICE Restart versuchen
      tryIceRestart();
    }
  };

  // Renegotiation Handler für neue Tracks (z.B. Screen Share)
  peerConnection.onnegotiationneeded = async () => {
    if (isNegotiating) {
      console.log("onnegotiationneeded: übersprungen (isNegotiating=true)");
      return;
    }
    if (peerConnection.signalingState !== "stable") {
      console.log("onnegotiationneeded: übersprungen (state=" + peerConnection.signalingState + ")");
      return;
    }
    isNegotiating = true;
    try {
      console.log("onnegotiationneeded: Erstelle Offer...");
      const offer = await peerConnection.createOffer();
      offer.sdp = optimizeAudioSDP(offer.sdp);
      await peerConnection.setLocalDescription(offer);
      socket.emit("signal", { offer });
      console.log("onnegotiationneeded: Offer gesendet ✓");
    } catch (err) {
      console.error("onnegotiationneeded Fehler:", err);
    } finally {
      isNegotiating = false;
    }
  };

  // Signaling State Logging
  peerConnection.onsignalingstatechange = () => {
    console.log("Signaling state:", peerConnection.signalingState);
  };

  // ---- ontrack: Kern-Fix für Screen Share + Audio ----
  peerConnection.ontrack = (event) => {
    const track = event.track;
    // streams[0] kann fehlen → manuell erstellen
    const stream = event.streams[0] || new MediaStream([track]);

    console.log(`ontrack: kind=${track.kind} streamId=${stream.id} streams=${event.streams.length}`);

    if (track.kind === "video") {
      // ── Screen Share Video vom Remote ──
      if (!remoteScreenStreams.has(stream.id)) {
        console.log("Screen Share Video empfangen → Container erstellen");
        const container = createVideoContainer(stream, "Sarah's Screen", false);
        const video = container.querySelector("video");
        video.muted = true; // Audio kommt separat oder über Audio-Track im selben Stream
        video.play().catch(e => console.warn("Video autoplay:", e));

        // Audio-Track im selben Stream? → separates Audio-Element
        let audioEl = null;
        if (stream.getAudioTracks().length > 0) {
          audioEl = new Audio();
          audioEl.srcObject = stream;
          audioEl.autoplay = true;
          audioEl.volume = 1;
          audioEl.play().catch(e => console.warn("Screen Audio play:", e));
          document.body.appendChild(audioEl);
        }

        remoteScreenStreams.set(stream.id, { container, audioEl });

        // Wenn später Audio-Track hinzukommt
        stream.onaddtrack = (e) => {
          if (e.track.kind === "audio" && !remoteScreenStreams.get(stream.id)?.audioEl) {
            const entry = remoteScreenStreams.get(stream.id);
            if (entry) {
              const newAudio = new Audio();
              newAudio.srcObject = stream;
              newAudio.autoplay = true;
              newAudio.volume = 1;
              newAudio.play().catch(() => {});
              document.body.appendChild(newAudio);
              entry.audioEl = newAudio;
            }
          }
        };
      }

      // Track-Ende → Container aufräumen
      track.onended = () => {
        const entry = remoteScreenStreams.get(stream.id);
        if (entry) {
          entry.container?.remove();
          entry.audioEl?.remove();
          remoteScreenStreams.delete(stream.id);
        }
        removeVideoContainer(stream.id);
      };

    } else if (track.kind === "audio") {
      // ── Mikrofon-Audio vom Remote ──
      // Nur wenn kein Video im selben Stream (sonst ist es Screen-Share-Audio → schon oben behandelt)
      if (stream.getVideoTracks().length > 0) {
        // Gehört zum Screen Share Stream → schon oben behandelt
        console.log("Audio-Track gehört zu Screen Share Stream → ignoriert");
        return;
      }

      console.log("Mikrofon-Audio empfangen, userAudioElements:", userAudioElements.size);

      // Passendes Audio-Element suchen (das noch keinen srcObject hat)
      let assigned = false;
      for (const [id, audio] of userAudioElements) {
        if (!audio.srcObject || audio.srcObject.getTracks().length === 0) {
          audio.srcObject = stream;
          audio.play().catch(e => console.warn("Audio play:", e));
          console.log("Mikrofon-Audio → User:", id);
          assigned = true;
          break;
        }
      }

      if (!assigned) {
        // Noch kein User-Tile → als pending speichern
        console.log("Kein User-Tile vorhanden → pending");
        pendingAudioStreams.push(stream);
      }
    }
  };
}

// ── ICE Restart bei failed connection ──
async function tryIceRestart() {
  if (!peerConnection || !localStream) return;
  try {
    console.log("ICE Restart...");
    const offer = await peerConnection.createOffer({ iceRestart: true });
    offer.sdp = optimizeAudioSDP(offer.sdp);
    await peerConnection.setLocalDescription(offer);
    socket.emit("signal", { offer });
    console.log("ICE Restart Offer gesendet ✓");
  } catch (e) {
    console.error("ICE Restart fehlgeschlagen:", e);
  }
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
    // Mikrofon holen - die Prüfung wird durch den tatsächlichen Versuch ersetzt
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("getUserMedia wird von diesem Browser nicht unterstützt");
    }

    localStream = await navigator.mediaDevices.getUserMedia({ 
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 48000,
        sampleSize: 16,
        channelCount: 2
      }
    });

    // PeerConnection erstellen
    await createPeerConnection();

    // Lokale Audio-Tracks hinzufügen mit hoher Bitrate
    localStream.getTracks().forEach(track => {
      const sender = peerConnection.addTrack(track, localStream);
      // Audio Encoding für hohe Qualität optimieren
      if (track.kind === 'audio') {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        params.encodings[0].maxBitrate = 510000; // 510 kbps Opus max
        sender.setParameters(params).catch(() => {});
      }
    });
    
    // Eigene User-Tile erstellen mit Profilbild
    createUserTile(socket.id, username, true, userProfilePic);
    
    // Beim Server registrieren
    socket.emit("register", { username, profilePic: userProfilePic });
    addSystemMessage(`Du bist als "${username}" beigetreten`);
    
    updateConnectionStatus(true);
    startStatsUpdate();
    
  } catch (err) {
    console.error("Fehler beim Joinen:", err);
    
    // Benutzerfreundliche Fehlermeldungen
    let errorMsg = err.message;
    
    if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
      errorMsg = "Zugriff auf Mikrofon verweigert. Bitte erlaube den Zugriff in den Browser-Einstellungen oder Systemeinstellungen.";
    } else if (err.name === "NotFoundError") {
      errorMsg = "Kein Mikrofon gefunden. Bitte verbinde ein Mikrofon.";
    } else if (err.name === "NotReadableError") {
      errorMsg = "Mikrofon wird bereits von einer anderen Anwendung verwendet. Bitte schließe diese und versuche es erneut.";
    } else if (err.name === "SecurityError") {
      errorMsg = "Sicherheitsfehler: Bitte stelle sicher, dass du HTTPS verwendest (außer localhost). Auf macOS: Überprüfe die Systemeinstellungen > Sicherheit & Datenschutz > Mikrofon.";
    } else if (err.name === "TypeError" || !navigator.mediaDevices) {
      errorMsg = "Dein Browser unterstützt keine Echtzeitkommunikation. Bitte nutze Chrome, Firefox oder Edge (neuste Version). Auf macOS: Stelle sicher, dass Safari aktualisiert ist und die Berechtigungen erteilt hat.";
    } else if (err.message && err.message.includes("getUserMedia")) {
      errorMsg = "Fehler beim Zugriff auf Mikrofon: " + err.message + ". Überprüfe deine Browser- und Systemeinstellungen.";
    }
    
    alert("Konnte nicht beitreten: " + errorMsg);
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

// ---- Quality Selector ----
qualityBtn.onclick = (e) => {
  e.stopPropagation();
  qualityDropdown.classList.toggle("visible");
};

// Dropdown schließen bei Klick außerhalb
document.addEventListener("click", (e) => {
  if (!qualityBtn.contains(e.target) && !qualityDropdown.contains(e.target)) {
    qualityDropdown.classList.remove("visible");
  }
});

qualityOptions.forEach(option => {
  option.onclick = () => {
    currentQuality = option.dataset.quality;
    const preset = qualityPresets[currentQuality];
    
    // UI aktualisieren
    qualityOptions.forEach(o => o.classList.remove("selected"));
    option.classList.add("selected");
    qualityBadge.textContent = preset.label;
    qualityDropdown.classList.remove("visible");
    
    // Wenn gerade gestreamt wird: Encoding live anpassen
    if (screenStream && peerConnection) {
      peerConnection.getSenders().forEach(sender => {
        if (sender.track && sender.track.kind === 'video' && screenStream.getVideoTracks().includes(sender.track)) {
          const params = sender.getParameters();
          if (!params.encodings) params.encodings = [{}];
          params.encodings[0].maxBitrate = preset.bitrate;
          params.encodings[0].maxFramerate = preset.fps;
          sender.setParameters(params).catch(e =>
            console.warn("Qualität konnte nicht live geändert werden:", e)
          );
          
          // Video-Track Constraints anpassen
          sender.track.applyConstraints({
            width: { ideal: preset.width, max: preset.width },
            height: { ideal: preset.height, max: preset.height },
            frameRate: { ideal: preset.fps, max: preset.fps }
          }).catch(e => console.warn("Track-Constraints konnten nicht angepasst werden:", e));
        }
      });
      console.log(`Stream Qualität auf ${preset.label} geändert (${preset.width}x${preset.height} @ ${preset.fps}fps)`);
    }
  };
});

// ---- Screen Share Button ----
screenBtn.onclick = async () => {
  if (!peerConnection) {
    alert("Zuerst Join klicken!");
    return;
  }

  try {
    const preset = qualityPresets[currentQuality];
    const videoConstraints = {
      frameRate: { ideal: preset.fps, max: preset.fps },
      width: { ideal: preset.width, max: preset.width },
      height: { ideal: preset.height, max: preset.height }
    };

    let audioFallbackUsed = false;

    // Versuch 1: Mit System-Audio (funktioniert in Electron auf Windows via loopback)
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: videoConstraints,
        audio: true,
        selfBrowserSurface: "exclude",
        surfaceSwitching: "include"
      });
      console.log("Screen Share: Audio erfolgreich ✓");
    } catch (err) {
      if (err.name === "NotReadableError" || err.name === "NotFoundError" || err.name === "AbortError") {
        console.warn("Screen Share: System-Audio fehlgeschlagen (" + err.name + ") → Versuche Fallback");
        screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: videoConstraints,
          audio: false,
          selfBrowserSurface: "exclude",
          surfaceSwitching: "include"
        });
        audioFallbackUsed = true;
      } else {
        throw err;
      }
    }

    // macOS + BlackHole: Audio separat per getUserMedia holen und zum Stream hinzufügen
    const blackHoleId = window._blackHoleDeviceId;
    if (blackHoleId) {
      try {
        const bhStream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { exact: blackHoleId }, channelCount: 2, sampleRate: 48000 }
        });
        bhStream.getAudioTracks().forEach(track => {
          screenStream.addTrack(track);
          screenStream.getVideoTracks()[0]?.addEventListener("ended", () => track.stop());
        });
        window._blackHoleDeviceId = null; // einmal benutzt → zurücksetzen
        audioFallbackUsed = false;
        console.log("Screen Share: BlackHole Audio hinzugefügt ✓");
        addSystemMessage("✅ BlackHole System-Audio aktiv");
      } catch (bhErr) {
        console.warn("BlackHole Audio fehlgeschlagen:", bhErr.message);
        audioFallbackUsed = true;
      }
    }

    // Letzter Fallback: Mikrofon als Audio-Quelle
    if (audioFallbackUsed && screenStream.getAudioTracks().length === 0) {
      try {
        const micFallback = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000, channelCount: 2 }
        });
        micFallback.getAudioTracks().forEach(track => {
          screenStream.addTrack(track);
          screenStream.getVideoTracks()[0]?.addEventListener("ended", () => track.stop());
        });
        addSystemMessage("⚠️ System-Audio nicht verfügbar — Mikrofon wird als Ton-Quelle genutzt");
        console.log("Screen Share: Mikrofon-Fallback aktiv ✓");
      } catch (micErr) {
        addSystemMessage("⚠️ Kein Ton beim Screen Share möglich");
        console.warn("Screen Share: Kein Audio verfügbar:", micErr.message);
      }
    }

    console.log("Screen Share Audio Tracks:", screenStream.getAudioTracks().length);

    // Video Container für lokale Vorschau erstellen
    createVideoContainer(screenStream, `${username}'s Screen (Vorschau)`, true);

    socket.emit("screen-share-started", { id: socket.id });

    isNegotiating = true;
    try {
      console.log("Screen Share: Füge Tracks hinzu...");

      screenStream.getTracks().forEach(track => {
        const sender = peerConnection.addTrack(track, screenStream);

        if (track.kind === 'video') {
          try { track.contentHint = 'detail'; } catch(e) {}

          try {
            const transceiver = peerConnection.getTransceivers().find(t => t.sender === sender);
            if (transceiver && typeof transceiver.setCodecPreferences === 'function') {
              const capabilities = RTCRtpReceiver.getCapabilities('video');
              if (capabilities && capabilities.codecs) {
                const vp8 = capabilities.codecs.filter(c => c.mimeType.toLowerCase() === 'video/vp8');
                const rest = capabilities.codecs.filter(c => c.mimeType.toLowerCase() !== 'video/vp8');
                if (vp8.length > 0) {
                  transceiver.setCodecPreferences([...vp8, ...rest]);
                  console.log('Screen Share: VP8 Codec bevorzugt');
                }
              }
            }
          } catch (codecErr) {
            console.warn('Codec-Präferenzen konnten nicht gesetzt werden:', codecErr);
          }

          const params = sender.getParameters();
          if (!params.encodings) params.encodings = [{}];
          params.encodings[0].maxBitrate = preset.bitrate;
          params.encodings[0].maxFramerate = preset.fps;
          sender.setParameters(params).catch(e =>
            console.warn("Video-Encoding fehlgeschlagen:", e)
          );
        }

        if (track.kind === 'audio') {
          const params = sender.getParameters();
          if (!params.encodings) params.encodings = [{}];
          params.encodings[0].maxBitrate = 320000;
          sender.setParameters(params).catch(e =>
            console.warn("Audio-Encoding fehlgeschlagen:", e)
          );
        }

        track.onended = () => {
          try { peerConnection.removeTrack(sender); } catch(e) {}
          if (track.kind === 'video') stopScreenShare();
        };
      });

      const offer = await peerConnection.createOffer();
      offer.sdp = optimizeAudioSDP(offer.sdp);
      await peerConnection.setLocalDescription(offer);
      socket.emit("signal", { offer });
      console.log("Screen Share: Renegotiation Offer gesendet ✓");
    } catch (reErr) {
      console.error("Screen Share: Renegotiation fehlgeschlagen:", reErr);
    } finally {
      isNegotiating = false;
    }

    setTimeout(() => {
      if (screenStream) {
        const videoTrack = screenStream.getVideoTracks()[0];
        if (videoTrack && videoTrack.readyState === 'ended') {
          console.error('Screen Share: Video Track gestorben');
          stopScreenShare();
        }
      }
    }, 2000);

    screenBtn.classList.add("active");
    screenBtn.style.display = "none";
    stopScreenBtn.style.display = "flex";

  } catch (err) {
    console.error("Screen Share Fehler:", err);
    if (err.name !== "NotAllowedError") {
      alert("Screen Share Fehler: " + err.name + "\n" + err.message);
    }
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

// ---- Killer Queue Button ----
queueBtn.onclick = async () => {
  const originalTitle = queueBtn.title;
  queueBtn.disabled = true;
  queueBtn.title = "Lädt...";

  try {
    const response = await fetch("/api/killer-queue");
    const raw = await response.text();
    let data;

    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error("Server lieferte kein JSON (falscher Server/Port oder API nicht verfügbar)");
    }

    if (!response.ok || !data.killerQueue) {
      throw new Error(data.error || "Queue nicht verfügbar");
    }

    const message = `🎯 Killer Queue: ${data.killerQueue}`;
    addSystemMessage(message);
    alert(message);
  } catch (error) {
    const message = `Killer Queue konnte nicht geladen werden: ${error.message}`;
    addSystemMessage(message);
    alert(message);
  } finally {
    queueBtn.disabled = false;
    queueBtn.title = originalTitle;
  }
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
  document.querySelectorAll('audio[data-pending-audio]').forEach(el => el.remove());
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
  try {
    if (data.offer) {
      // PeerConnection erstellen falls noch nicht vorhanden
      await createPeerConnection();
      
      // Glare-Handling: Wenn wir bereits ein Offer gesendet haben (have-local-offer),
      // müssen wir erst zurückrollen bevor wir das Remote-Offer annehmen
      if (peerConnection.signalingState === 'have-local-offer') {
        console.log('Glare detected: Rolling back local offer');
        await peerConnection.setLocalDescription({ type: 'rollback' });
      }

      await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));

      // eigenes Mikrofon hinzufügen, falls noch nicht vorhanden
      if (!localStream) {
        localStream = await navigator.mediaDevices.getUserMedia({ 
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 48000,
            sampleSize: 16,
            channelCount: 2
          }
        });
        localStream.getTracks().forEach(track => {
          const sender = peerConnection.addTrack(track, localStream);
          if (track.kind === 'audio') {
            const params = sender.getParameters();
            if (!params.encodings || params.encodings.length === 0) {
              params.encodings = [{}];
            }
            params.encodings[0].maxBitrate = 510000;
            sender.setParameters(params).catch(() => {});
          }
        });
        updateConnectionStatus(true);
        startStatsUpdate();
      }

      const answer = await peerConnection.createAnswer();
      answer.sdp = optimizeAudioSDP(answer.sdp); // Apply SDP optimization
      await peerConnection.setLocalDescription(answer);
      socket.emit("signal", { answer });
    }

    if (data.answer && peerConnection) {
      // Nur setzen wenn wir tatsächlich auf eine Antwort warten
      if (peerConnection.signalingState === 'have-local-offer') {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
      } else {
        console.warn('Answer ignoriert — signalingState ist:', peerConnection.signalingState);
      }
    }

    if (data.candidate && peerConnection) {
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (iceErr) {
        console.warn('ICE candidate konnte nicht hinzugefügt werden:', iceErr);
      }
    }
  } catch (err) {
    console.error('Signaling Fehler:', err);
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
      currentContextTarget.video.play().catch(() => {});
    }
    hideContextMenu();
  };
}

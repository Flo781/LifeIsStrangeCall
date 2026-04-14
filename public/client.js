// ============================================================
// client.js — LifeIsStrangeCall
// ============================================================

// ---- Server-Verbindung ----
// Standardmäßig Railway (gemeinsamer Server für unterschiedliche Netzwerke).
// Im Verbindungs-Modal kann eine andere URL eingegeben werden.
const DEFAULT_SERVER_URL = "https://lifeisstrange-production.up.railway.app";

// Socket.IO-Verbindung wird erst nach Modal-Bestätigung aufgebaut.
let socket = null;
let currentServerUrl = localStorage.getItem("serverUrl") || DEFAULT_SERVER_URL;
let isFirst = false;         // true = erste Person im Call (sendet das Offer)
let peerReady = false;       // Ist der andere User bereits verbunden?

// ---- WebRTC Zustand ----
let localStream = null;
let originalMicStream = null;  // Original-Mikrofon-Stream (für Echo-Cancellation-Referenz)
let micAudioContext = null;    // Globaler AudioContext für Mikrofon-Boost
let peerConnection = null;
let screenStream = null;
let isMuted = false;
let statsInterval = null;
let vadInterval = null;
let isNegotiating = false;
let username = "";
let userProfilePic = "";

// ---- Screen-Share AEC ----
let screenAecContext = null;
let aecProcessedAudioTrack = null;

// ---- Track-Zuordnung ----
let participants = new Map();       // socketId -> { username, tile, profilePic }
let userAudioElements = new Map();  // socketId -> <audio>
let remoteScreenStreams = new Map(); // streamId -> { container, audioEl }

// Wenn ein Screen-Share-Angebot kommt, speichern wir die Stream-ID vorab
// damit ontrack sie korrekt zuordnen kann (Fix für Audio-vor-Video-Bug)
let expectedScreenStreamId = null;

// Streams die ankamen bevor ein User-Tile existiert
let pendingAudioStreams = [];

// Flag: User hat "Verbinden" geklickt und möchte dem Call beitreten
let shouldJoinCall = false;
let callJoinTimeout = null;

// ---- Qualitäts-Presets ----
const qualityPresets = {
  low:    { width: 1280, height: 720,  fps: 30, bitrate: 2500000,  label: "SD" },
  medium: { width: 1920, height: 1080, fps: 30, bitrate: 5000000,  label: "HD" },
  high:   { width: 1920, height: 1080, fps: 60, bitrate: 8000000,  label: "FHD" },
  ultra:  { width: 2560, height: 1440, fps: 60, bitrate: 12000000, label: "QHD" }
};
let currentQuality = "medium";

// ---- Profilbilder ----
const profilePictures = {
  "Sarah": "/assets/Profilbilder/images.jfif",
  "Flores": "/assets/Profilbilder/images (1).jfif"
};

// ---- ICE-Konfiguration ----
const iceConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    {
      urls: ["turn:openrelay.metered.ca:80", "turn:openrelay.metered.ca:443"],
      username: "openrelayproject",
      credential: "openrelayproject"
    }
  ],
  iceTransportPolicy: "all",
};

// ============================================================
// Hilfsfunktionen
// ============================================================

function escapeHtml(text) {
  const d = document.createElement("div");
  d.textContent = text;
  return d.innerHTML;
}

function optimizeAudioSDP(sdp) {
  // Opus optimieren — kein Stereo (stört Echo-Cancellation)
  return sdp
    .replace(
      /a=fmtp:111 minptime=10;useinbandfec=1/g,
      "a=fmtp:111 minptime=10;useinbandfec=1;maxaveragebitrate=510000;maxplaybackrate=48000"
    )
    .replace(
      /a=fmtp:111 minptime=10\n/g,
      "a=fmtp:111 minptime=10;useinbandfec=1;maxaveragebitrate=510000;maxplaybackrate=48000\n"
    );
}

// ---- Mikrofon-Boost via GainNode ----
// Wichtig: Der geboostete Stream verliert Browser-Echo-Cancellation,
// daher sollte die Gegenseite Kopfhörer nutzen wenn sie Screen-Shared.
async function boostMicStream(stream) {
  try {
    // Alten AudioContext schließen falls vorhanden
    if (micAudioContext) {
      try { micAudioContext.close(); } catch (e) { /* ignore */ }
    }

    micAudioContext = new AudioContext();
    await micAudioContext.resume();

    const source = micAudioContext.createMediaStreamSource(stream);
    const gain = micAudioContext.createGain();
    gain.gain.value = MIC_GAIN;
    const dest = micAudioContext.createMediaStreamDestination();

    source.connect(gain);
    gain.connect(dest);

    console.log(`Mikrofon-Boost aktiv: ${MIC_GAIN}x`);
    return dest.stream;
  } catch (e) {
    console.error("Mikrofon-Boost Fehler:", e);
    return stream;  // Fallback: Original-Stream
  }
}

// ---- Loopback Echo Cancellation ----
// Zieht die bekannte Partner-Stimme (Reference) aus dem WASAPI-Loopback heraus,
// bevor das System-Audio an die Gegenseite gesendet wird.
// So hört sich der Partner nicht selbst doppelt im Stream-Audio.
function createLoopbackAEC(loopbackStream, referenceStream) {
  const SAMPLE_RATE = 48000;
  // Geschätzte Latenz vom Abspielen bis zur Loopback-Erfassung (~40 ms)
  const DELAY_SAMPLES = Math.round(0.04 * SAMPLE_RATE);
  const CANCEL_GAIN   = 0.85;

  const ctx  = new AudioContext({ sampleRate: SAMPLE_RATE });
  const lSrc = ctx.createMediaStreamSource(loopbackStream);
  const rSrc = ctx.createMediaStreamSource(referenceStream);

  // Ringpuffer für das Reference-Signal (1 Sekunde)
  const refBuf = new Float32Array(SAMPLE_RATE);
  let writeIdx = 0;

  // Mono-Downmix per GainNode (falls Stereo-Quellen)
  const toMono = (src) => {
    const g = ctx.createGain();
    g.channelCount     = 1;
    g.channelCountMode = "explicit";
    src.connect(g);
    return g;
  };

  const merger = ctx.createChannelMerger(2);
  toMono(lSrc).connect(merger, 0, 0); // Kanal 0 = Loopback
  toMono(rSrc).connect(merger, 0, 1); // Kanal 1 = Reference

  // ScriptProcessor: liest Loopback (ch0) und Reference (ch1),
  // gibt Loopback − verzögertes Reference aus
  const proc = ctx.createScriptProcessor(512, 2, 1);
  proc.onaudioprocess = (ev) => {
    const loIn  = ev.inputBuffer.getChannelData(0);
    const refIn = ev.inputBuffer.getChannelData(1);
    const out   = ev.outputBuffer.getChannelData(0);

    // Reference in Ringpuffer schreiben
    for (let i = 0; i < refIn.length; i++) {
      refBuf[(writeIdx + i) % refBuf.length] = refIn[i];
    }
    // Loopback − verzögerte Reference → sauberes Game-Audio
    for (let i = 0; i < loIn.length; i++) {
      const ri = ((writeIdx + i - DELAY_SAMPLES) % refBuf.length + refBuf.length) % refBuf.length;
      out[i] = loIn[i] - refBuf[ri] * CANCEL_GAIN;
    }
    writeIdx = (writeIdx + refIn.length) % refBuf.length;
  };

  merger.connect(proc);
  const dest = ctx.createMediaStreamDestination();
  proc.connect(dest);

  console.log("Loopback-AEC erstellt ✓");
  return { ctx, processedStream: dest.stream };
}

// ---- Sound-Effekte ----
function playTone(freqs) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, ctx.currentTime + i * 0.15);
      gain.gain.setValueAtTime(0.2, ctx.currentTime + i * 0.15);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.15 + 0.4);
      osc.start(ctx.currentTime + i * 0.15);
      osc.stop(ctx.currentTime + i * 0.15 + 0.5);
    });
  } catch (e) { /* ignorieren */ }
}

// ============================================================
// UI-Elemente
// ============================================================
const joinBtn          = document.getElementById("joinBtn");
const muteBtn          = document.getElementById("muteBtn");
const screenBtn        = document.getElementById("screenBtn");
const statsBtn         = document.getElementById("statsBtn");
const queueBtn         = document.getElementById("queueBtn");
const leaveBtn         = document.getElementById("leaveBtn");
const stopScreenBtn    = document.getElementById("stopScreenBtn");
const statusDot        = document.getElementById("statusDot");
const statusText       = document.getElementById("statusText");
const videoGrid        = document.getElementById("videoGrid");
const emptyState       = document.getElementById("emptyState");
const statsOverlay     = document.getElementById("statsOverlay");
const chatMessages     = document.getElementById("chatMessages");
const chatInput        = document.getElementById("chatInput");
const chatSend         = document.getElementById("chatSend");
const qualityBtn       = document.getElementById("qualityBtn");
const qualityDropdown  = document.getElementById("qualityDropdown");
const qualityBadge     = document.getElementById("qualityBadge");
const qualityOptions   = document.querySelectorAll(".quality-option");
const usernameModal    = document.getElementById("usernameModal");
const profileOptions   = document.querySelectorAll(".profile-option");
const contextMenu      = document.getElementById("contextMenu");
const participantsList = document.getElementById("participantsList");
const contextVolumeSlider = document.getElementById("contextVolumeSlider");
const contextVolumeLabel  = document.getElementById("contextVolumeValue");
const contextFullscreen   = document.getElementById("contextFullscreen");
const audioDeviceBtn      = document.getElementById("audioDeviceBtn");
const audioDeviceModal    = document.getElementById("audioDeviceModal");
const inputDeviceSelect   = document.getElementById("inputDevice");
const outputDeviceSelect  = document.getElementById("outputDevice");
const audioDeviceApply    = document.getElementById("audioDeviceApply");
const audioDeviceCancel   = document.getElementById("audioDeviceCancel");

// Verbindungs-Modal
const connectionModal  = document.getElementById("connectionModal");
const serverUrlInput   = document.getElementById("serverUrlInput");
const connectBtn       = document.getElementById("connectBtn");
const connectionStatus = document.getElementById("connectionModalStatus");

let selectedInputDeviceId  = null;
let selectedOutputDeviceId = null;
let currentContextTarget   = null;

// ============================================================
// Socket.IO Verbindung aufbauen
// ============================================================
function connectSocket(url) {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
  }

  socket = io(url, {
    transports: ["polling", "websocket"],  // polling-first — zuverlässiger auf Railway/Heroku
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 8000,
    timeout: 20000,
  });

  socket.on("connect", () => {
    console.log("✓ Socket.IO verbunden:", socket.id);
    setConnectionModalStatus("Verbunden ✓ — trete Call bei...", "green");

    // Flag gesetzt → connect-to-call senden (egal ob erster Connect oder Reconnect)
    if (shouldJoinCall && username) {
      socket.emit("connect-to-call", { username, profilePic: userProfilePic });

      // Timeout: wenn nach 6s kein call-joined kommt → Fehlermeldung
      if (callJoinTimeout) clearTimeout(callJoinTimeout);
      callJoinTimeout = setTimeout(() => {
        if (shouldJoinCall) {
          setConnectionModalStatus(
            "Keine Antwort vom Server. Bitte Railway neu deployen oder Server-URL prüfen.",
            "red"
          );
          if (connectBtn) { connectBtn.disabled = false; connectBtn.textContent = "Erneut versuchen"; }
        }
      }, 6000);
    }
  });

  socket.on("disconnect", (reason) => {
    console.log("✗ Socket.IO getrennt:", reason);
    updateConnectionStatus(false);
    if (peerConnection) {
      addSystemMessage("⚠️ Server-Verbindung unterbrochen — versuche neu zu verbinden...");
    }
  });

  socket.on("connect_error", (err) => {
    console.error("✗ Verbindungsfehler:", err.message);
    setConnectionModalStatus("Verbindungsfehler: " + err.message, "red");
  });

  // ---- Call-Events ----
  socket.on("call-joined", ({ users, isFirst: first }) => {
    shouldJoinCall = false;
    if (callJoinTimeout) { clearTimeout(callJoinTimeout); callJoinTimeout = null; }
    isFirst = first;
    console.log("Call beigetreten, isFirst:", isFirst, "Users:", users.length);
    closeConnectionModal();

    if (users.length === 1) {
      // Erste Person — warte auf die andere
      startCall(users);
      setConnectionModalStatus("Warte auf Gesprächspartner...", "orange");
      addSystemMessage("⏳ Warte auf Gesprächspartnerin...");
    } else {
      // Zweite Person — beide direkt starten
      startCall(users);
    }
  });

  socket.on("call-error", ({ message }) => {
    setConnectionModalStatus("Fehler: " + message, "red");
    if (connectBtn) { connectBtn.disabled = false; connectBtn.textContent = "Verbinden"; }
  });

  socket.on("peer-joined", ({ id, username: peerName, profilePic }) => {
    console.log("Gegenseite beigetreten:", peerName);
    peerReady = true;

    if (peerConnection) {
      createUserTile(id, peerName, false, profilePic);
      addSystemMessage(`${peerName} ist beigetreten`);
      playTone([440, 660]);
    }

    // Erste Person sendet das Offer
    if (isFirst && peerConnection) {
      sendOffer();
    }
  });

  socket.on("peer-left", ({ id, username: peerName }) => {
    addSystemMessage(`${peerName} hat den Call verlassen`);
    playTone([660, 440]);
    removeUserTile(id);
    // Remote Screen-Streams entfernen
    remoteScreenStreams.forEach((entry, streamId) => {
      entry.audioEl?.remove();
      removeVideoContainer(streamId);
    });
    remoteScreenStreams.clear();
    expectedScreenStreamId = null;
  });

  // ---- WebRTC Signaling ----
  socket.on("signal", handleSignal);

  // ---- Chat ----
  socket.on("chat-message", (msg) => addChatMessage(msg));

  // ---- Screen Share gestoppt ----
  socket.on("screen-share-stopped", () => {
    remoteScreenStreams.forEach((entry, streamId) => {
      entry.audioEl?.remove();
      removeVideoContainer(streamId);
    });
    remoteScreenStreams.clear();
    expectedScreenStreamId = null;
    addSystemMessage("Screen Share beendet");
  });
}

// ============================================================
// Verbindungs-Modal
// ============================================================
function setConnectionModalStatus(msg, color) {
  if (!connectionStatus) return;
  connectionStatus.textContent = msg;
  connectionStatus.style.color = color === "green" ? "#4ade80"
    : color === "red" ? "#e94560"
    : color === "orange" ? "#f59e0b"
    : "#ccc";
}

function showRoomCode(code) {
  if (roomCodeDisplay) roomCodeDisplay.classList.remove("hidden");
  if (joinSection) joinSection.classList.add("hidden");
  if (roomCodeText) roomCodeText.textContent = code;
  if (createRoomBtn) createRoomBtn.disabled = true;
  if (joinRoomBtn) joinRoomBtn.disabled = true;
}

function closeConnectionModal() {
  if (connectionModal) connectionModal.classList.add("hidden");
}

// "Verbinden"-Button
if (connectBtn) {
  connectBtn.onclick = () => {
    if (!username) {
      setConnectionModalStatus("Bitte zuerst ein Profil wählen.", "red");
      return;
    }
    const url = (serverUrlInput?.value?.trim()) || DEFAULT_SERVER_URL;
    currentServerUrl = url;
    localStorage.setItem("serverUrl", url);
    connectBtn.disabled = true;
    connectBtn.textContent = "Verbinde...";
    setConnectionModalStatus("Verbinde mit Server...", "orange");

    shouldJoinCall = true;
    connectSocket(url);
  };
}

// ============================================================
// Profil-Auswahl
// ============================================================
profileOptions.forEach(option => {
  option.onclick = () => {
    username = option.dataset.name;
    userProfilePic = profilePictures[username] || "";
    usernameModal.classList.add("hidden");
    // Verbindungs-Modal anzeigen
    if (connectionModal) {
      connectionModal.classList.remove("hidden");
      if (serverUrlInput) serverUrlInput.value = currentServerUrl;
      if (connectBtn) { connectBtn.disabled = false; connectBtn.textContent = "Verbinden"; }
      setConnectionModalStatus("", "#ccc");
    }
  };
});

// ============================================================
// Call starten (nach Raum-Beitritt)
// ============================================================
async function startCall(users) {
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("getUserMedia wird nicht unterstützt");
    }

    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        googEchoCancellation: true,
        googEchoCancellation2: true,
        googDAEchoCancellation: true,   // Delay-agnostisches AEC (hilft bei Software-Loopback)
        googAutoGainControl: true,
        googAutoGainControl2: true,
        googNoiseSuppression: true,
        googHighpassFilter: true,
        noiseSuppression: true,
        autoGainControl: true,          // Browser-AGC erhält die AEC-Referenz aufrecht
        sampleRate: 48000,
        channelCount: 1,
        ...(selectedInputDeviceId ? { deviceId: { exact: selectedInputDeviceId } } : {})
      }
    });
    // Kein manueller Boost: Browser-AGC normalisiert die Lautstärke ohne die AEC zu brechen

    await createPeerConnection();

    // Eigene Tracks hinzufügen
    localStream.getTracks().forEach(track => {
      const sender = peerConnection.addTrack(track, localStream);
      if (track.kind === "audio") {
        const params = sender.getParameters();
        if (!params.encodings?.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = 510000;
        sender.setParameters(params).catch(() => {});
      }
    });

    // User-Tiles für alle im Raum erstellen
    users.forEach(u => {
      createUserTile(u.id, u.username, u.id === socket?.id, u.profilePic);
    });

    updateConnectionStatus(true);
    startStatsUpdate();
    startVADLoop();
    enableButtons(true);

    addSystemMessage(`Du bist als "${username}" beigetreten`);

    // Erste Person sendet das Offer sobald die zweite beitritt (via peer-joined)
    // Zweite Person: Offer kommt vom Server, Answer wird gesendet
    if (isFirst && users.length >= 2) {
      await sendOffer();
    }

  } catch (err) {
    console.error("startCall Fehler:", err);
    let msg = err.message;
    if (err.name === "NotAllowedError") msg = "Mikrofon-Zugriff verweigert.";
    else if (err.name === "NotFoundError") msg = "Kein Mikrofon gefunden.";
    else if (err.name === "NotReadableError") msg = "Mikrofon wird von einer anderen App verwendet.";
    alert("Call konnte nicht gestartet werden:\n" + msg);
  }
}

// ============================================================
// PeerConnection erstellen
// ============================================================
async function createPeerConnection() {
  if (peerConnection) return;

  peerConnection = new RTCPeerConnection(iceConfig);

  peerConnection.onicecandidate = (e) => {
    if (e.candidate) socket?.emit("signal", { candidate: e.candidate });
  };

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;
    console.log("Connection state:", state);
    if (state === "connected") {
      updateConnectionStatus(true);
      addSystemMessage("✅ Direkt verbunden!");
    } else if (state === "disconnected") {
      updateConnectionStatus(false);
      addSystemMessage("⚠️ Verbindung unterbrochen — versuche Neuverbindung...");
      // Nach 3 Sekunden ICE Restart falls noch disconnected
      setTimeout(() => {
        if (peerConnection?.connectionState === "disconnected") {
          doIceRestart();
        }
      }, 3000);
    } else if (state === "failed") {
      updateConnectionStatus(false);
      addSystemMessage("❌ Verbindung fehlgeschlagen — ICE Restart...");
      doIceRestart();
    }
  };

  peerConnection.onsignalingstatechange = () => {
    console.log("Signaling state:", peerConnection.signalingState);
  };

  peerConnection.onnegotiationneeded = async () => {
    if (isNegotiating || peerConnection.signalingState !== "stable") return;
    isNegotiating = true;
    try {
      const offer = await peerConnection.createOffer();
      offer.sdp = optimizeAudioSDP(offer.sdp);
      await peerConnection.setLocalDescription(offer);
      socket?.emit("signal", { offer });
    } catch (e) {
      console.error("onnegotiationneeded Fehler:", e);
    } finally {
      isNegotiating = false;
    }
  };

  // ---- ontrack: Remote-Streams empfangen ----
  peerConnection.ontrack = (event) => {
    const track = event.track;
    const stream = event.streams?.[0];

    // Kein Stream → ignorieren (sollte nicht passieren)
    if (!stream) return;

    // Eigenen lokalen Stream nie abspielen (verhindert Selbst-Echo)
    if (stream.id === localStream?.id) {
      console.warn("ontrack: eigener lokaler Stream empfangen — ignoriert");
      return;
    }

    console.log(`ontrack: kind=${track.kind} streamId=${stream.id}`);

    if (track.kind === "video") {
      handleRemoteVideoTrack(track, stream);
    } else if (track.kind === "audio") {
      handleRemoteAudioTrack(track, stream);
    }
  };
}

// ============================================================
// SCREEN SHARE: Remote Video-Track
// ============================================================
function handleRemoteVideoTrack(track, stream) {
  if (remoteScreenStreams.has(stream.id)) return; // schon verarbeitet

  let remoteUsername = "";
  participants.forEach((data, id) => {
    if (id !== socket?.id) remoteUsername = data.username;
  });
  const label = remoteUsername ? `${remoteUsername}'s Screen` : "Screen Share";

  // Nur den Video-Track ins Video-Element laden — Audio kommt ausschließlich
  // über ein separates <audio>-Element (handleRemoteAudioTrack). So kann das
  // Video-Element niemals Audio ausgeben, egal welchen muted-Zustand es hat.
  const videoOnlyStream = new MediaStream(stream.getVideoTracks());
  const container = createVideoContainer(videoOnlyStream, label, false);
  container.dataset.streamId = stream.id; // originale Stream-ID für Tracking beibehalten
  const video = container.querySelector("video");
  video.play().catch(() => {});

  remoteScreenStreams.set(stream.id, { container, audioEl: null });
  console.log(`Screen Share Video registriert: ${stream.id}`);

  track.onended = () => {
    const entry = remoteScreenStreams.get(stream.id);
    if (entry) {
      entry.audioEl?.remove();
      remoteScreenStreams.delete(stream.id);
    }
    removeVideoContainer(stream.id);
    expectedScreenStreamId = null;
  };
}

// ============================================================
// SCREEN SHARE: Remote Audio-Track
// Kernfix: Stream-ID vs. expectedScreenStreamId prüfen
// ============================================================
// Mikrofon-Audio des Partners muten wenn Screen-Share-Audio empfangen wird
// (die Stimme kommt eh schon über das System-Audio im Screen Share)
function muteRemoteMicDuringScreenShare() {
  for (const [, audioEl] of userAudioElements) {
    audioEl.dataset.wasMutedByScreen = "true";
    audioEl.muted = true;
  }
  console.log("Remote-Mic gemutet (Screen-Share-Audio aktiv)");
}

function unmuteRemoteMicAfterScreenShare() {
  for (const [, audioEl] of userAudioElements) {
    if (audioEl.dataset.wasMutedByScreen === "true") {
      audioEl.muted = false;
      delete audioEl.dataset.wasMutedByScreen;
    }
  }
  console.log("Remote-Mic entmutet (Screen Share beendet)");
}

function handleRemoteAudioTrack(track, stream) {
  // Niemals eigenen lokalen Stream abspielen
  if (stream.id === localStream?.id || stream.id === screenStream?.id) {
    console.warn("handleRemoteAudioTrack: lokaler Stream — ignoriert");
    return;
  }

  // Fall 1: Stream ist als Screen-Share bekannt (Video kam zuerst)
  if (remoteScreenStreams.has(stream.id)) {
    const entry = remoteScreenStreams.get(stream.id);
    if (!entry.audioEl) {
      entry.audioEl = createScreenAudioElement(stream);
      console.log("Screen-Audio zugeordnet (via remoteScreenStreams)");
    }
    return;
  }

  // Fall 2: Stream-ID stimmt mit vorab gemeldeter Screen-Share-Stream-ID überein
  // (Audio-Track kam BEVOR Video-Track — das ist der ursprüngliche Bug!)
  if (stream.id === expectedScreenStreamId) {
    console.log("Screen-Audio zugeordnet (via expectedScreenStreamId, Audio vor Video)");
    // Kurz warten bis der Video-Track in remoteScreenStreams landet
    const waitAndAssign = (retries = 10) => {
      const entry = remoteScreenStreams.get(stream.id);
      if (entry) {
        if (!entry.audioEl) {
          entry.audioEl = createScreenAudioElement(stream);
        }
      } else if (retries > 0) {
        setTimeout(() => waitAndAssign(retries - 1), 150);
      } else {
        // Fallback: eigenes Audio-Element erstellen
        createScreenAudioElement(stream);
      }
    };
    waitAndAssign();
    return;
  }

  // Fall 3: Mikrofon-Audio → User-Tile zuweisen
  console.log("Mikrofon-Audio empfangen");
  let assigned = false;
  for (const [id, audioEl] of userAudioElements) {
    if (!audioEl.srcObject || audioEl.srcObject.getTracks().length === 0) {
      audioEl.srcObject = stream;
      audioEl.play().catch(e => console.warn("Audio play:", e));
      startVAD(stream, id);
      assigned = true;
      console.log("Mikrofon-Audio → User:", id);
      break;
    }
  }

  if (!assigned) {
    console.log("Kein User-Tile → pending");
    pendingAudioStreams.push(stream);
  }
}

// ============================================================
// Signaling Handler
// ============================================================
async function handleSignal(data) {
  try {
    // Screen-Share-Info: vorab empfangen bevor die Tracks kommen
    if (data.screenShareStreamId !== undefined) {
      expectedScreenStreamId = data.screenShareStreamId;
      console.log("Expected Screen Stream ID:", expectedScreenStreamId);
      return;
    }

    if (data.offer) {
      await createPeerConnection();

      // Glare-Behandlung
      if (peerConnection.signalingState === "have-local-offer") {
        console.log("Glare: Rollback");
        await peerConnection.setLocalDescription({ type: "rollback" });
      }

      await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));

      // Mikrofon hinzufügen falls noch nicht vorhanden
      if (!localStream) {
        localStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            googEchoCancellation: true,
            googEchoCancellation2: true,
            googDAEchoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            googAutoGainControl: true,
            sampleRate: 48000,
            channelCount: 1
          }
        });

        localStream.getTracks().forEach(track => {
          const sender = peerConnection.addTrack(track, localStream);
          if (track.kind === "audio") {
            const p = sender.getParameters();
            if (!p.encodings?.length) p.encodings = [{}];
            p.encodings[0].maxBitrate = 510000;
            sender.setParameters(p).catch(() => {});
          }
        });
        updateConnectionStatus(true);
        startStatsUpdate();
        startVADLoop();
        enableButtons(true);
      }

      const answer = await peerConnection.createAnswer();
      answer.sdp = optimizeAudioSDP(answer.sdp);
      await peerConnection.setLocalDescription(answer);
      socket.emit("signal", { answer });
      console.log("Answer gesendet ✓");
    }

    if (data.answer && peerConnection) {
      if (peerConnection.signalingState === "have-local-offer") {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
        console.log("Answer empfangen ✓");
      } else {
        console.warn("Answer ignoriert — state:", peerConnection.signalingState);
      }
    }

    if (data.candidate && peerConnection) {
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (e) {
        console.warn("ICE Candidate Fehler:", e.message);
      }
    }

  } catch (err) {
    console.error("Signaling Fehler:", err);
  }
}

// ============================================================
// Offer senden (Host)
// ============================================================
async function sendOffer() {
  if (!peerConnection || isNegotiating) return;
  if (peerConnection.signalingState !== "stable") {
    console.log("sendOffer übersprungen, state:", peerConnection.signalingState);
    return;
  }
  isNegotiating = true;
  try {
    const offer = await peerConnection.createOffer();
    offer.sdp = optimizeAudioSDP(offer.sdp);
    await peerConnection.setLocalDescription(offer);
    socket.emit("signal", { offer });
    console.log("Offer gesendet ✓");
  } catch (e) {
    console.error("sendOffer Fehler:", e);
  } finally {
    isNegotiating = false;
  }
}

// ICE Restart
async function doIceRestart() {
  if (!peerConnection) return;
  try {
    const offer = await peerConnection.createOffer({ iceRestart: true });
    offer.sdp = optimizeAudioSDP(offer.sdp);
    await peerConnection.setLocalDescription(offer);
    socket?.emit("signal", { offer });
    console.log("ICE Restart Offer gesendet ✓");
  } catch (e) {
    console.error("ICE Restart Fehler:", e);
  }
}

// ============================================================
// Screen-Share-Audio-Element erstellen
// ============================================================
function createScreenAudioElement(stream) {
  const el = new Audio();
  el.srcObject = stream;
  el.autoplay = true;
  el.volume = 1;
  el.dataset.screenAudio = "true";
  document.body.appendChild(el);
  el.play().catch(e => console.warn("Screen Audio play:", e));
  console.log("Screen-Audio-Element erstellt ✓");
  return el;
}

// ============================================================
// Video-Container (für Screen Share)
// ============================================================
function createVideoContainer(stream, label, isLocal = false) {
  const container = document.createElement("div");
  container.className = "video-container";
  container.dataset.streamId = stream.id;

  const video = document.createElement("video");
  video.srcObject = stream;
  video.autoplay = true;
  video.playsInline = true;
  video.muted = isLocal;
  if (!isLocal) video.volume = 1;

  const labelDiv = document.createElement("div");
  labelDiv.className = "label";
  labelDiv.innerHTML = `
    <div class="speaking-indicator"></div>
    <span>${escapeHtml(label)}</span>
    ${!isLocal ? '<span class="audio-hint">🔊</span>' : ''}
  `;

  if (!isLocal) {
    container.oncontextmenu = (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, container, video);
    };
  }

  const hint = document.createElement("div");
  hint.className = "fullscreen-hint";
  hint.textContent = "Doppelklick für Vollbild";

  container.ondblclick = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      container.requestFullscreen();
      video.play().catch(() => {});
    }
  };

  container.appendChild(video);
  container.appendChild(labelDiv);
  container.appendChild(hint);
  videoGrid.appendChild(container);
  emptyState.style.display = "none";
  return container;
}

function removeVideoContainer(streamId) {
  videoGrid.querySelector(`[data-stream-id="${streamId}"]`)?.remove();
}

// ============================================================
// User-Tile (Discord-Stil)
// ============================================================
function createUserTile(userId, name, isLocal = false, profilePic = "") {
  if (document.querySelector(`[data-user-id="${userId}"]`)) return;

  const tile = document.createElement("div");
  tile.className = "user-tile";
  tile.dataset.userId = userId;

  const avatar = profilePic
    ? `<img src="${profilePic}" alt="${name}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`
    : name.charAt(0).toUpperCase();

  tile.innerHTML = `
    <div class="speaking-ring"></div>
    <div class="avatar">${avatar}</div>
    <div class="username">${escapeHtml(name)}${isLocal ? " (Du)" : ""}</div>
    <div class="status-icons">
      <div class="status-icon volume-icon">
        <svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>
      </div>
    </div>
  `;

  if (!isLocal) {
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.volume = 1;
    audio.dataset.userId = userId;
    document.body.appendChild(audio);

    // Pending Audio-Stream zuweisen falls bereits angekommen
    if (pendingAudioStreams.length > 0) {
      const stream = pendingAudioStreams.shift();
      audio.srcObject = stream;
      audio.play().catch(e => console.warn("Pending audio play:", e));
      startVAD(stream, userId);
      console.log("Pending Audio → User:", userId);
    }

    userAudioElements.set(userId, audio);

    tile.oncontextmenu = (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, tile, audio);
    };
  }

  participants.set(userId, { username: name, tile, profilePic });
  videoGrid.appendChild(tile);
  emptyState.style.display = "none";
  updateParticipantCount();
  updateParticipantsList();
  return tile;
}

function removeUserTile(userId) {
  document.querySelector(`[data-user-id="${userId}"]`)?.remove();
  userAudioElements.get(userId)?.remove();
  userAudioElements.delete(userId);
  stopVAD(userId);
  participants.delete(userId);
  updateParticipantCount();
  updateParticipantsList();

  const remaining = videoGrid.querySelectorAll(".user-tile, .video-container");
  if (remaining.length === 0) emptyState.style.display = "flex";
}

// ============================================================
// VAD (Voice Activity Detection)
// ============================================================
const vadAnalysers = new Map();

function startVAD(stream, userId) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.3;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    vadAnalysers.set(userId, { analyser, data, ctx });
  } catch (e) {
    console.warn("VAD Fehler:", e);
  }
}

function stopVAD(userId) {
  const entry = vadAnalysers.get(userId);
  if (entry) {
    try { entry.ctx.close(); } catch (e) { /* ignore */ }
    vadAnalysers.delete(userId);
  }
}

function startVADLoop() {
  if (vadInterval) return;
  vadInterval = setInterval(() => {
    vadAnalysers.forEach(({ analyser, data }, userId) => {
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      const speaking = avg > 12;
      document.querySelector(`[data-user-id="${userId}"]`)?.classList.toggle("speaking", speaking);
      document.querySelector(`[data-participant-id="${userId}"]`)?.classList.toggle("speaking", speaking);
    });
  }, 80);
}

// ============================================================
// Join-Button (öffnet Profil-Modal)
// ============================================================
joinBtn.onclick = () => {
  if (peerConnection) return;
  if (!username) {
    usernameModal.classList.remove("hidden");
    return;
  }
  // Username schon gewählt → direkt Verbindungs-Modal
  if (connectionModal) {
    connectionModal.classList.remove("hidden");
    if (serverUrlInput) serverUrlInput.value = currentServerUrl;
    if (connectBtn) { connectBtn.disabled = false; connectBtn.textContent = "Verbinden"; }
    setConnectionModalStatus("", "#ccc");
  }
};

// ============================================================
// Mute-Button
// ============================================================
muteBtn.onclick = () => {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
  muteBtn.classList.toggle("muted", isMuted);
  document.getElementById("muteIcon").innerHTML = isMuted
    ? '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>'
    : '<path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z"/>';
};

// ============================================================
// Qualitäts-Selektor
// ============================================================
qualityBtn.onclick = (e) => {
  e.stopPropagation();
  qualityDropdown.classList.toggle("visible");
};

document.addEventListener("click", (e) => {
  if (!qualityBtn.contains(e.target) && !qualityDropdown.contains(e.target)) {
    qualityDropdown.classList.remove("visible");
  }
});

qualityOptions.forEach(opt => {
  opt.onclick = () => {
    currentQuality = opt.dataset.quality;
    const preset = qualityPresets[currentQuality];
    qualityOptions.forEach(o => o.classList.remove("selected"));
    opt.classList.add("selected");
    qualityBadge.textContent = preset.label;
    qualityDropdown.classList.remove("visible");

    if (screenStream && peerConnection) {
      peerConnection.getSenders().forEach(sender => {
        if (sender.track?.kind !== "video") return;
        if (!screenStream.getVideoTracks().includes(sender.track)) return;
        const p = sender.getParameters();
        if (!p.encodings) p.encodings = [{}];
        p.encodings[0].maxBitrate = preset.bitrate;
        p.encodings[0].maxFramerate = preset.fps;
        sender.setParameters(p).catch(() => {});
        sender.track.applyConstraints({
          width: { ideal: preset.width },
          height: { ideal: preset.height },
          frameRate: { ideal: preset.fps }
        }).catch(() => {});
      });
    }
  };
});

// ============================================================
// Screen Share
// ============================================================
const { ipcRenderer } = window.require ? window.require("electron") : { ipcRenderer: null };

screenBtn.onclick = async () => {
  if (!peerConnection) { alert("Zuerst Join klicken!"); return; }

  try {
    const preset = qualityPresets[currentQuality];

    // Versuche zuerst mit Audio (Loopback auf Windows via Electron)
    let gotAudio = false;
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: preset.width },
          height: { ideal: preset.height },
          frameRate: { ideal: preset.fps }
        },
        audio: {
          echoCancellation: true,
          googEchoCancellation: true,
          googDAEchoCancellation: true,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: 48000,
          channelCount: 2
        }
      });
      gotAudio = screenStream.getAudioTracks().length > 0;
    } catch {
      // Fallback: ohne detaillierte Audio-Constraints
      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: preset.width },
            height: { ideal: preset.height },
            frameRate: { ideal: preset.fps }
          },
          audio: true
        });
        gotAudio = screenStream.getAudioTracks().length > 0;
      } catch {
        screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: false
        });
      }
    }

    if (!screenStream?.getTracks().length) { screenStream = null; return; }

    console.log(`Screen Share: ${screenStream.getVideoTracks().length} Video, ${screenStream.getAudioTracks().length} Audio Tracks`);

    if (!gotAudio) {
      addSystemMessage("⚠️ System-Audio nicht verfügbar — nur Video wird übertragen");
    } else {
      // Loopback-Echo-Cancellation: Partner-Stimme softwareseitig aus dem
      // WASAPI-Loopback herausrechnen, bevor es gesendet wird.
      // Niemand wird stummgeschaltet — Kommunikation läuft normal weiter.
      const remoteAudioEl = [...userAudioElements.values()][0];
      if (remoteAudioEl?.srcObject && remoteAudioEl.srcObject.getAudioTracks().length > 0) {
        try {
          const loopStream = new MediaStream(screenStream.getAudioTracks());
          const refStream  = new MediaStream(remoteAudioEl.srcObject.getAudioTracks());
          const { ctx, processedStream } = createLoopbackAEC(loopStream, refStream);
          screenAecContext         = ctx;
          aecProcessedAudioTrack   = processedStream.getAudioTracks()[0];
          addSystemMessage("🔊 Echo-Schutz aktiv (Loopback-AEC)");
        } catch (e) {
          console.error("AEC konnte nicht erstellt werden:", e);
          aecProcessedAudioTrack = null;
        }
      }
    }

    // KERNFIX: Stream-ID VOR der Renegotiation an Gegenseite senden
    // damit ontrack die Audio-Tracks korrekt zuordnen kann
    socket.emit("signal", { screenShareStreamId: screenStream.id });

    // Lokale Vorschau
    createVideoContainer(screenStream, `${username}'s Screen (Vorschau)`, true);

    // Tracks zur PeerConnection hinzufügen
    isNegotiating = true;
    try {
      screenStream.getTracks().forEach(track => {
        // Audio: AEC-verarbeiteten Track senden statt rohem Loopback
        const trackToSend = (track.kind === "audio" && aecProcessedAudioTrack)
          ? aecProcessedAudioTrack
          : track;
        const sender = peerConnection.addTrack(trackToSend, screenStream);

        if (track.kind === "video") {
          try { track.contentHint = "detail"; } catch (e) { /* ignore */ }
          // VP8 bevorzugen
          try {
            const transceiver = peerConnection.getTransceivers().find(t => t.sender === sender);
            if (transceiver?.setCodecPreferences) {
              const caps = RTCRtpReceiver.getCapabilities("video");
              if (caps?.codecs) {
                const vp8 = caps.codecs.filter(c => c.mimeType.toLowerCase() === "video/vp8");
                const rest = caps.codecs.filter(c => c.mimeType.toLowerCase() !== "video/vp8");
                if (vp8.length) transceiver.setCodecPreferences([...vp8, ...rest]);
              }
            }
          } catch (e) { /* ignore */ }

          const p = sender.getParameters();
          if (!p.encodings) p.encodings = [{}];
          p.encodings[0].maxBitrate = preset.bitrate;
          p.encodings[0].maxFramerate = preset.fps;
          sender.setParameters(p).catch(() => {});
        }

        if (track.kind === "audio") {
          const p = sender.getParameters();
          if (!p.encodings) p.encodings = [{}];
          p.encodings[0].maxBitrate = 320000;
          sender.setParameters(p).catch(() => {});
        }

        track.onended = () => {
          try { peerConnection.removeTrack(sender); } catch (e) { /* ignore */ }
          if (track.kind === "video") stopScreenShare();
        };
      });

      const offer = await peerConnection.createOffer();
      offer.sdp = optimizeAudioSDP(offer.sdp);
      await peerConnection.setLocalDescription(offer);
      socket.emit("signal", { offer });
      console.log("Screen Share Renegotiation Offer gesendet ✓");
    } finally {
      isNegotiating = false;
    }

    screenBtn.style.display = "none";
    stopScreenBtn.style.display = "flex";

  } catch (err) {
    console.error("Screen Share Fehler:", err);
    if (err.name !== "NotAllowedError") {
      alert("Screen Share Fehler: " + err.message);
    }
    screenStream = null;
  }
};

stopScreenBtn.onclick = () => stopScreenShare();

function stopScreenShare() {
  if (!screenStream) return;
  const stream = screenStream;
  screenStream = null;  // sofort auf null setzen damit doppelte Aufrufe ignoriert werden

  const id = stream.id;

  // Tracks aus PeerConnection entfernen —
  // auch den AEC-processed Track berücksichtigen (nicht in stream.getTracks())
  if (peerConnection) {
    const origTracks = new Set(stream.getTracks());
    const aecTrack   = aecProcessedAudioTrack; // Referenz sichern bevor sie genullt wird
    peerConnection.getSenders()
      .filter(s => s.track && (origTracks.has(s.track) || s.track === aecTrack))
      .forEach(s => { try { peerConnection.removeTrack(s); } catch (e) { /* ignore */ } });
  }

  // AEC-Kontext beenden (nach Sender-Entfernung)
  if (screenAecContext) {
    try { screenAecContext.close(); } catch (e) { /* ignore */ }
    screenAecContext       = null;
    aecProcessedAudioTrack = null;
  }

  stream.getTracks().forEach(t => t.stop());
  removeVideoContainer(id);
  socket?.emit("screen-share-stopped");
  expectedScreenStreamId = null;



  screenBtn.style.display = "flex";
  stopScreenBtn.style.display = "none";
}

// ============================================================
// Leave-Button
// ============================================================
leaveBtn.onclick = () => cleanup();

function cleanup() {
  if (peerConnection) socket?.emit("leave-call");

  if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }
  if (vadInterval) { clearInterval(vadInterval); vadInterval = null; }
  vadAnalysers.forEach((_, id) => stopVAD(id));
  vadAnalysers.clear();

  // AudioContexts schließen
  if (micAudioContext) {
    try { micAudioContext.close(); } catch (e) { /* ignore */ }
    micAudioContext = null;
  }
  if (screenAecContext) {
    try { screenAecContext.close(); } catch (e) { /* ignore */ }
    screenAecContext       = null;
    aecProcessedAudioTrack = null;
  }
  localStream?.getTracks().forEach(t => t.stop());
  localStream = null;
  originalMicStream?.getTracks().forEach(t => t.stop());
  originalMicStream = null;

  screenStream?.getTracks().forEach(t => t.stop());
  screenStream = null;

  peerConnection?.close();
  peerConnection = null;

  isNegotiating = false;
  expectedScreenStreamId = null;
  peerReady = false;
  shouldJoinCall = false;
  if (callJoinTimeout) { clearTimeout(callJoinTimeout); callJoinTimeout = null; }

  removeUserTile(socket?.id || "");
  videoGrid.querySelectorAll(".user-tile").forEach(el => el.remove());
  videoGrid.querySelectorAll(".video-container").forEach(el => el.remove());
  document.querySelectorAll("audio[data-screen-audio]").forEach(el => el.remove());

  participants.clear();
  userAudioElements.forEach(a => a.remove());
  userAudioElements.clear();
  remoteScreenStreams.forEach(e => e.audioEl?.remove());
  remoteScreenStreams.clear();
  pendingAudioStreams.length = 0;

  updateConnectionStatus(false);
  updateParticipantsList();
  updateParticipantCount();
  enableButtons(false);
  screenBtn.style.display = "flex";
  stopScreenBtn.style.display = "none";
  muteBtn.classList.remove("muted");
  isMuted = false;
  emptyState.style.display = "flex";
}

// ============================================================
// Stats
// ============================================================
statsBtn.onclick = () => statsOverlay.classList.toggle("visible");

function startStatsUpdate() {
  statsInterval = setInterval(async () => {
    if (!peerConnection) return;
    const stats = await peerConnection.getStats();
    let res = "-", fps = "-", bitrate = "-", rtt = "-";
    stats.forEach(r => {
      if (r.type === "outbound-rtp" && r.kind === "video") {
        res = `${r.frameWidth || 0}x${r.frameHeight || 0}`;
        fps = String(r.framesPerSecond || 0);
      }
      if (r.type === "candidate-pair" && r.state === "succeeded") {
        rtt = `${Math.round((r.currentRoundTripTime || 0) * 1000)} ms`;
      }
      if (r.type === "outbound-rtp" && r.bytesSent) {
        bitrate = `${Math.round(r.bytesSent * 8 / 1000)} kbps`;
      }
    });
    document.getElementById("statRes").textContent = res;
    document.getElementById("statFps").textContent = fps;
    document.getElementById("statBitrate").textContent = bitrate;
    document.getElementById("statLatency").textContent = rtt;
  }, 1000);
}

// ============================================================
// Killer Queue
// ============================================================
queueBtn.onclick = async () => {
  queueBtn.disabled = true;
  try {
    const res = await fetch("/api/killer-queue");
    const data = await res.json();
    if (!data.killerQueue) throw new Error(data.error || "Unbekannt");
    const msg = `🎯 Killer Queue: ${data.killerQueue}`;
    addSystemMessage(msg);
    alert(msg);
  } catch (e) {
    const msg = "Queue nicht verfügbar: " + e.message;
    addSystemMessage(msg);
    alert(msg);
  } finally {
    queueBtn.disabled = false;
  }
};

// ============================================================
// Chat
// ============================================================
chatSend.onclick = sendMessage;
chatInput.onkeypress = (e) => { if (e.key === "Enter") sendMessage(); };

function sendMessage() {
  const text = chatInput.value.trim();
  if (!text || !socket) return;
  socket.emit("chat-message", text);
  chatInput.value = "";
}

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

// ============================================================
// UI-Hilfsfunktionen
// ============================================================
function updateConnectionStatus(connected) {
  statusDot.classList.toggle("connected", connected);
  statusText.textContent = connected ? "Verbunden" : "Nicht verbunden";
}

function enableButtons(on) {
  muteBtn.disabled = !on;
  screenBtn.disabled = !on;
  leaveBtn.disabled = !on;
  joinBtn.disabled = on;
}

function updateParticipantCount() {
  const el = document.getElementById("participantCount");
  if (el) el.textContent = participants.size;
}

function updateParticipantsList() {
  if (!participantsList) return;
  participantsList.innerHTML = "";
  participants.forEach((data, id) => {
    const isMe = id === socket?.id;
    const avatar = data.profilePic
      ? `<img src="${data.profilePic}" alt="${data.username}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`
      : data.username.charAt(0).toUpperCase();
    const item = document.createElement("div");
    item.className = "participant-item";
    item.innerHTML = `
      <div class="participant-avatar" data-participant-id="${id}">${avatar}</div>
      <div class="participant-name${isMe ? " you" : ""}">${escapeHtml(data.username)}${isMe ? " (Du)" : ""}</div>
      <div class="participant-status">🟢</div>
    `;
    participantsList.appendChild(item);
  });
}

// ============================================================
// Kontext-Menü
// ============================================================
function showContextMenu(x, y, container, mediaEl) {
  currentContextTarget = { container, video: mediaEl };
  const mw = 200, mh = 150;
  if (x + mw > window.innerWidth) x = window.innerWidth - mw - 10;
  if (y + mh > window.innerHeight) y = window.innerHeight - mh - 10;
  contextMenu.style.left = x + "px";
  contextMenu.style.top = y + "px";
  contextMenu.classList.add("visible");
  const vol = Math.round((mediaEl.volume || 1) * 100);
  contextVolumeSlider.value = vol;
  if (contextVolumeLabel) contextVolumeLabel.textContent = vol + "%";
}

function hideContextMenu() {
  contextMenu.classList.remove("visible");
  currentContextTarget = null;
}

document.addEventListener("click", (e) => {
  if (!contextMenu.contains(e.target)) hideContextMenu();
});

if (contextVolumeSlider) {
  contextVolumeSlider.oninput = () => {
    if (!currentContextTarget) return;
    const vol = contextVolumeSlider.value / 100;
    currentContextTarget.video.volume = vol;
    if (contextVolumeLabel) contextVolumeLabel.textContent = contextVolumeSlider.value + "%";
  };
}

if (contextFullscreen) {
  contextFullscreen.onclick = () => {
    if (!currentContextTarget) return;
    const el = currentContextTarget.container;
    if (document.fullscreenElement) document.exitFullscreen();
    else el.requestFullscreen?.();
    hideContextMenu();
  };
}

// ============================================================
// Audio-Geräte
// ============================================================
audioDeviceBtn.onclick = async () => {
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {});
    const devices = await navigator.mediaDevices.enumerateDevices();
    inputDeviceSelect.innerHTML = "";
    outputDeviceSelect.innerHTML = '<option value="">Standard</option>';
    devices.forEach(d => {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || `${d.kind} (${d.deviceId.slice(0, 8)})`;
      if (d.kind === "audioinput") {
        if (d.deviceId === selectedInputDeviceId) opt.selected = true;
        inputDeviceSelect.appendChild(opt);
      } else if (d.kind === "audiooutput") {
        if (d.deviceId === selectedOutputDeviceId) opt.selected = true;
        outputDeviceSelect.appendChild(opt);
      }
    });
    audioDeviceModal.classList.remove("hidden");
  } catch (e) {
    alert("Fehler beim Laden der Audio-Geräte: " + e.message);
  }
};

audioDeviceCancel.onclick = () => audioDeviceModal.classList.add("hidden");

audioDeviceApply.onclick = async () => {
  const newIn = inputDeviceSelect.value;
  const newOut = outputDeviceSelect.value;
  audioDeviceModal.classList.add("hidden");

  if (newIn && newIn !== selectedInputDeviceId) {
    selectedInputDeviceId = newIn;
    try {
      const rawStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: newIn }, echoCancellation: true, googEchoCancellation: true, googEchoCancellation2: true, noiseSuppression: true, autoGainControl: false, channelCount: 1 }
      });

      // Mikrofon-Boost anwenden
      originalMicStream = rawStream;
      const boostedStream = await boostMicStream(rawStream);
      const newTrack = boostedStream.getAudioTracks()[0];

      if (localStream) {
        localStream.getAudioTracks().forEach(t => t.stop());
        localStream = boostedStream;
        if (peerConnection) {
          const sender = peerConnection.getSenders().find(s => s.track?.kind === "audio");
          if (sender) await sender.replaceTrack(newTrack);
        }
      }
      addSystemMessage("🎤 Mikrofon geändert: " + rawStream.getAudioTracks()[0]?.label);
    } catch (e) {
      alert("Eingabegerät konnte nicht gewechselt werden: " + e.message);
    }
  }

  if (newOut !== undefined) {
    selectedOutputDeviceId = newOut || null;
    for (const el of [...document.querySelectorAll("audio"), ...document.querySelectorAll("video")]) {
      if (typeof el.setSinkId === "function") {
        await el.setSinkId(newOut || "").catch(() => {});
      }
    }
    addSystemMessage("🔊 Ausgabegerät geändert");
  }
};

audioDeviceModal.addEventListener("click", (e) => {
  if (e.target === audioDeviceModal) audioDeviceModal.classList.add("hidden");
});

// ============================================================
// Aufräumen beim Schließen
// ============================================================
window.addEventListener("beforeunload", cleanup);

// ============================================================
// Call Timer
// ============================================================
let callTimerInterval = null;
const callTimerEl = document.getElementById("callTimer");

function startCallTimer() {
  if (callTimerInterval) return;
  const start = Date.now();
  if (callTimerEl) callTimerEl.style.display = "block";
  callTimerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - start) / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const p = n => String(n).padStart(2, "0");
    if (callTimerEl) callTimerEl.textContent = h > 0 ? `${p(h)}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
  }, 1000);
}

function stopCallTimer() {
  clearInterval(callTimerInterval);
  callTimerInterval = null;
  if (callTimerEl) { callTimerEl.textContent = "00:00"; callTimerEl.style.display = "none"; }
}

// Timer starten wenn Join-Button deaktiviert (= Call aktiv)
{
  const obs = new MutationObserver(() => {
    if (!leaveBtn.disabled && !callTimerInterval) startCallTimer();
    if (leaveBtn.disabled && callTimerInterval)  stopCallTimer();
  });
  obs.observe(leaveBtn, { attributes: true, attributeFilter: ["disabled"] });
}

// ============================================================
// Push-to-Talk (Leertaste)
// ============================================================
let pttEnabled = false;
let pttActive  = false;
const pttBtn    = document.getElementById("pttBtn");
const pttBadge  = document.getElementById("pttBadge");

if (pttBtn) {
  pttBtn.onclick = () => {
    pttEnabled = !pttEnabled;
    pttBtn.classList.toggle("active", pttEnabled);
    pttBtn.title = pttEnabled ? "Push-to-Talk: AN (Leertaste)" : "Push-to-Talk: AUS";
    if (pttEnabled) {
      // Mikro stummschalten im PTT-Modus
      isMuted = true;
      if (localStream) localStream.getAudioTracks().forEach(t => { t.enabled = false; });
      muteBtn.classList.add("muted");
      document.getElementById("muteIcon").innerHTML = MUTED_ICON;
      addSystemMessage("🎤 Push-to-Talk aktiv — Leertaste halten zum Sprechen");
    } else {
      isMuted = false;
      if (localStream) localStream.getAudioTracks().forEach(t => { t.enabled = true; });
      muteBtn.classList.remove("muted");
      document.getElementById("muteIcon").innerHTML = MIC_ICON;
      addSystemMessage("🎤 Push-to-Talk deaktiviert");
    }
  };
}

const MIC_ICON   = '<path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z"/>';
const MUTED_ICON = '<path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.34 3 3 3 .23 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/>';

document.addEventListener("keydown", (e) => {
  if (!pttEnabled || e.code !== "Space" || e.repeat) return;
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  e.preventDefault();
  if (pttActive) return;
  pttActive = true;
  if (localStream) localStream.getAudioTracks().forEach(t => { t.enabled = true; });
  if (pttBadge) pttBadge.style.display = "block";
});

document.addEventListener("keyup", (e) => {
  if (!pttEnabled || e.code !== "Space") return;
  pttActive = false;
  if (localStream) localStream.getAudioTracks().forEach(t => { t.enabled = false; });
  if (pttBadge) pttBadge.style.display = "none";
});

// PTT-Button mit enableButtons verknüpfen
{
  const origEnable = enableButtons;
  enableButtons = function(on) {
    origEnable(on);
    if (pttBtn) pttBtn.disabled = !on;
    if (!on && pttEnabled) {
      pttEnabled = false;
      if (pttBtn) pttBtn.classList.remove("active");
      if (pttBadge) pttBadge.style.display = "none";
    }
  };
}

// ============================================================
// Emoji Reaktionen
// ============================================================
const EMOJIS      = ["❤️","😂","😮","👏","🔥","👍","🎮","💀","🌊","✨"];
const emojiBtn    = document.getElementById("emojiBtn");
const emojiPicker = document.getElementById("emojiPicker");
const emojiOverlay= document.getElementById("emojiOverlay");

// Picker aufbauen
if (emojiPicker) {
  emojiPicker.style.display = "none"; // initial verstecken
  EMOJIS.forEach(e => {
    const btn = document.createElement("div");
    btn.textContent = e;
    Object.assign(btn.style, {
      fontSize: "22px", padding: "5px", borderRadius: "6px",
      cursor: "pointer", textAlign: "center", transition: "background .15s"
    });
    btn.onmouseenter = () => btn.style.background = "rgba(255,255,255,.12)";
    btn.onmouseleave = () => btn.style.background = "transparent";
    btn.onclick = (ev) => {
      ev.stopPropagation();
      spawnEmoji(e);
      if (socket) socket.emit("chat-message", e);
      emojiPicker.style.display = "none";
    };
    emojiPicker.appendChild(btn);
  });
  // Grid-Layout aktivieren
  emojiPicker.style.display = "none";
  emojiPicker.style.gridTemplateColumns = "repeat(5,1fr)";
}

if (emojiBtn) {
  emojiBtn.onclick = (ev) => {
    ev.stopPropagation();
    const isVisible = emojiPicker.style.display === "grid";
    emojiPicker.style.display = isVisible ? "none" : "grid";
  };
}

document.addEventListener("click", () => {
  if (emojiPicker) emojiPicker.style.display = "none";
});

function spawnEmoji(emoji) {
  if (!emojiOverlay) return;
  const el = document.createElement("div");
  el.textContent = emoji;
  el.style.cssText = `position:absolute;font-size:36px;left:${5+Math.random()*85}%;bottom:15%;animation:emojiFloat 3s ease-out forwards;pointer-events:none`;
  emojiOverlay.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// CSS-Animation injizieren
const emojiStyle = document.createElement("style");
emojiStyle.textContent = `@keyframes emojiFloat{0%{transform:translateY(0) scale(1);opacity:1}80%{opacity:1}100%{transform:translateY(-220px) scale(1.3);opacity:0}}`;
document.head.appendChild(emojiStyle);

// Eingehende Emojis floaten lassen
{
  const origAddChat = addChatMessage;
  addChatMessage = function(msg) {
    origAddChat(msg);
    if (msg.id !== socket?.id && isEmojiOnly(msg.text)) spawnEmoji(msg.text);
  };
}

function isEmojiOnly(str) {
  return str.trim().length <= 8 &&
    /^[\u{1F300}-\u{1FFFF}\u{2600}-\u{27BF}❤👍💀🌊✨\s]+$/u.test(str.trim());
}

// ============================================================
// DBD Killer Queue Panel
// ============================================================
const dbdTimeEl  = document.getElementById("dbdTime");
const dbdMetaEl  = document.getElementById("dbdMeta");
const dbdRefBtn  = document.getElementById("dbdRefreshBtn");

async function fetchDbdPanel() {
  if (!dbdTimeEl) return;
  if (dbdRefBtn) dbdRefBtn.disabled = true;
  dbdTimeEl.textContent = "…";
  try {
    // Direkt vom Browser aufgerufen (CORS: *) — kein Server-Proxy nötig
    const r = await fetch("https://api.deadbyqueue.com/queues", {
      signal: AbortSignal.timeout(8000),
      headers: { "Accept": "application/json" }
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const data  = await r.json();
    const rawQ  = data?.queues ?? {};
    const mode  = ["live","live-event","ptb","ptb-event"].find(m => rawQ[m]) ?? Object.keys(rawQ)[0];
    if (!mode) throw new Error("Keine Queue-Daten");

    const killerRaw = rawQ[mode]?.["eu-central-1"]?.killer?.time;
    let killerQueue;
    if (killerRaw == null || killerRaw === "x") killerQueue = "Keine Daten";
    else {
      const secs = parseInt(killerRaw, 10);
      killerQueue = isFinite(secs)
        ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`
        : "Unbekannt";
    }
    dbdTimeEl.textContent = killerQueue;
    if (dbdMetaEl) dbdMetaEl.textContent = mode ? `Modus: ${mode}` : "Frankfurt · Live";
  } catch (e) {
    dbdTimeEl.textContent = "—";
    if (dbdMetaEl) dbdMetaEl.textContent = e.name === "TimeoutError" ? "Timeout" : "Nicht erreichbar";
  } finally {
    if (dbdRefBtn) dbdRefBtn.disabled = false;
  }
}

// queueBtn ebenfalls Panel aktualisieren lassen
{
  const origClick = queueBtn.onclick;
  queueBtn.onclick = () => { fetchDbdPanel(); if (origClick) origClick(); };
}

setInterval(fetchDbdPanel, 120_000);
fetchDbdPanel();

// ============================================================
// Participants Liste patchen (neue class-Namen)
// ============================================================
{
  const origUpdate = updateParticipantsList;
  updateParticipantsList = function() {
    if (!participantsList) return;
    participantsList.innerHTML = "";
    participants.forEach((data, id) => {
      const isMe = id === socket?.id;
      const avatarInner = data.profilePic
        ? `<img src="${data.profilePic}" alt="${escapeHtml(data.username)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`
        : escapeHtml(data.username.charAt(0).toUpperCase());
      const item = document.createElement("div");
      item.className = "participant-item";
      item.innerHTML = `
        <div class="avatar" style="width:28px;height:28px;font-size:12px">${avatarInner}</div>
        <span class="name${isMe ? " you" : ""}">${escapeHtml(data.username)}${isMe ? " (Du)" : ""}</span>
      `;
      participantsList.appendChild(item);
    });
  };
}


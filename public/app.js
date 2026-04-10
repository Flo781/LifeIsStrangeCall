/* LifeIsStrangeCall — Vue 3 + PrimeVue 3 Application
   Requires: Vue 3 (global), PrimeVue 3 (UMD), ToastService, Socket.IO
*/
(function () {
  'use strict';

  // ── Vue / PrimeVue globals ─────────────────────────────────────
  const { createApp, ref, reactive, computed, nextTick, onMounted, onUnmounted, getCurrentInstance } = Vue;

  // Resolve PrimeVue modules from UMD globals (multiple fallback paths)
  function resolvePv(key) {
    const ns = window.primevue;
    if (!ns) return null;
    const mod = ns[key];
    return mod?.default ?? mod ?? null;
  }

  const PrimeVue      = resolvePv('config');
  const ToastService  = window.primevue?.toastservice?.default ?? window.primevue?.toastservice ?? { install() {} };
  const PvToast       = resolvePv('toast');
  const PvDialog      = resolvePv('dialog');
  const PvButton      = resolvePv('button');
  const PvInputText   = resolvePv('inputtext');
  const PvSlider      = resolvePv('slider');
  const PvTooltip     = window.primevue?.tooltip?.default ?? window.primevue?.tooltip ?? {};

  // ── Constants ──────────────────────────────────────────────────
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ];

  const QUALITY_PRESETS = {
    low:    { label: 'Niedrig', width: 640,  height: 360,  fps: 15, bitrate: 500_000 },
    medium: { label: 'Mittel',  width: 1280, height: 720,  fps: 30, bitrate: 1_500_000 },
    high:   { label: 'Hoch',    width: 1920, height: 1080, fps: 30, bitrate: 4_000_000 },
    ultra:  { label: 'Ultra',   width: 2560, height: 1440, fps: 60, bitrate: 8_000_000 },
  };

  const EMOJIS = ['❤️', '😂', '😮', '👏', '🔥', '👍', '🎮', '💀', '🌊', '✨'];

  const PROFILE_PICS = {
    Sarah:  '/assets/pfp/sarah.png',
    Flores: '/assets/pfp/flores.png',
  };

  // ── App ────────────────────────────────────────────────────────
  const App = {
    setup() {
      // Toast helper — resolved once app is mounted
      let _toastFn = null;
      function showToast(severity, summary, detail = '') {
        if (_toastFn) {
          _toastFn.add({ severity, summary, detail: detail || undefined, life: 3500 });
        } else {
          console.log(`[Toast] ${severity}: ${summary} ${detail}`);
        }
      }

      // ── Reactive State ─────────────────────────────────────────
      const ui = reactive({
        showProfile:     true,
        showConnection:  false,
        showAudioDevice: false,
        showStats:       false,
        showEmoji:       false,
        showQuality:     false,
        connecting:      false,
      });

      const queue        = reactive({ loading: false, time: '', error: '', mode: '' });
      const participants = reactive({});   // socketId → participant object
      const chatMessages = ref([]);
      const chatInput    = ref('');
      const call         = reactive({ active: false, connected: false });
      const isMuted      = ref(false);
      const pttEnabled   = ref(false);
      const pttActive    = ref(false);
      const isScreenSharing = ref(false);
      const callDuration = ref('');
      const netQuality   = ref('unknown');
      const activeEmojis = ref([]);
      const emojis       = ref(EMOJIS);
      const qualityPresets  = ref(QUALITY_PRESETS);
      const currentQuality  = ref('medium');
      const stats        = reactive({ res: '—', fps: '—', bitrate: '—', rtt: '—' });
      const ctx          = reactive({ visible: false, x: 0, y: 0, volume: 100, targetId: null });
      const unreadCount  = ref(0);
      const serverUrl    = ref('https://life-is-strange-callwin.up.railway.app');
      const connStatus   = reactive({ text: 'Profil wählen…', color: 'var(--lis-muted)' });
      const selectedInput  = ref('');
      const selectedOutput = ref('');
      const audioInputs  = ref([]);
      const audioOutputs = ref([]);
      const profilePics  = ref(PROFILE_PICS);
      const chatEl       = ref(null);

      // ── Non-reactive runtime vars ──────────────────────────────
      let mySocketId    = null;
      let myUsername    = '';
      let myProfilePic  = '';
      let socket        = null;
      let pc            = null;   // RTCPeerConnection
      let localStream   = null;
      let screenStream  = null;
      let aecCtx        = null;
      let aecTrack      = null;
      let remoteAudio   = null;
      let remoteVolume  = 1.0;
      let callStart     = null;
      let timerInt      = null;
      let statsInt      = null;
      let queueInt      = null;
      let vadInt        = null;
      let tileUpdateInts = {};

      // ── Computed ───────────────────────────────────────────────
      const participantCount = computed(() => Object.keys(participants).length);
      const qualityLabel     = computed(() => QUALITY_PRESETS[currentQuality.value]?.label ?? 'Mittel');

      // ── Utility ────────────────────────────────────────────────
      function pad(n) { return String(n).padStart(2, '0'); }

      function formatDuration(secs) {
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        const s = secs % 60;
        return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
      }

      function sysMsg(text) {
        chatMessages.value.push({ id: Date.now() + Math.random(), type: 'system', text });
        scrollChat();
      }

      function scrollChat() {
        nextTick(() => {
          const el = chatEl.value;
          if (el) el.scrollTop = el.scrollHeight;
        });
      }

      // ── Profile ────────────────────────────────────────────────
      function selectProfile(name) {
        myUsername   = name;
        myProfilePic = PROFILE_PICS[name] ?? '';
        ui.showProfile    = false;
        ui.showConnection = true;
        connStatus.text  = 'Bereit zum Verbinden';
        connStatus.color = 'var(--lis-muted)';
      }

      function openConnectionModal() {
        if (!myUsername) { ui.showProfile = true; return; }
        ui.showConnection = true;
      }

      // ── Audio Devices ──────────────────────────────────────────
      async function loadAudioDevices() {
        try {
          const devs = await navigator.mediaDevices.enumerateDevices();
          audioInputs.value  = devs.filter(d => d.kind === 'audioinput');
          audioOutputs.value = devs.filter(d => d.kind === 'audiooutput');
          if (!selectedInput.value  && audioInputs.value.length)  selectedInput.value  = audioInputs.value[0].deviceId;
          if (!selectedOutput.value && audioOutputs.value.length) selectedOutput.value = audioOutputs.value[0].deviceId;
        } catch {}
      }

      function openAudioDevices() {
        loadAudioDevices();
        ui.showAudioDevice = true;
      }

      async function applyAudioDevices() {
        ui.showAudioDevice = false;
        // Replace mic track in peer connection
        if (localStream && pc) {
          try {
            const newStream = await navigator.mediaDevices.getUserMedia({
              audio: buildAudioConstraints(),
              video: false,
            });
            const newTrack = newStream.getAudioTracks()[0];
            const oldTracks = new Set(localStream.getAudioTracks());
            const sender = pc.getSenders().find(s => s.track && oldTracks.has(s.track));
            if (sender) await sender.replaceTrack(newTrack);
            oldTracks.forEach(t => { t.stop(); localStream.removeTrack(t); });
            localStream.addTrack(newTrack);
            if (isMuted.value) newTrack.enabled = false;
            setupVAD();
          } catch (e) { console.warn('Mic-Wechsel fehlgeschlagen:', e); }
        }
        // Set output device
        if (remoteAudio && selectedOutput.value && remoteAudio.setSinkId) {
          try { await remoteAudio.setSinkId(selectedOutput.value); } catch {}
        }
        showToast('success', 'Audio', 'Geräte übernommen');
      }

      function buildAudioConstraints() {
        const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
        if (selectedInput.value) base.deviceId = { exact: selectedInput.value };
        return base;
      }

      // ── Connect ────────────────────────────────────────────────
      async function connectToServer() {
        if (ui.connecting) return;
        ui.connecting = true;
        connStatus.text  = 'Mikrofon wird geöffnet…';
        connStatus.color = '#fbbf24';

        try {
          localStream = await navigator.mediaDevices.getUserMedia({
            audio: buildAudioConstraints(),
            video: false,
          });
          await loadAudioDevices();
        } catch (e) {
          connStatus.text  = 'Mikrofon-Zugriff verweigert';
          connStatus.color = 'var(--lis-accent)';
          ui.connecting = false;
          return;
        }

        connStatus.text = 'Verbinde mit Server…';
        socket = io(serverUrl.value, {
          transports: ['websocket', 'polling'],
          reconnection: true,
          reconnectionDelay: 2000,
        });

        socket.on('connect', () => {
          mySocketId = socket.id;
          connStatus.text  = 'Trete Call bei…';
          connStatus.color = 'var(--lis-green)';
          socket.emit('connect-to-call', { username: myUsername, profilePic: myProfilePic });
        });

        socket.on('connect_error', (e) => {
          connStatus.text  = 'Verbindungsfehler: ' + (e.message || e);
          connStatus.color = 'var(--lis-accent)';
          ui.connecting = false;
        });

        socket.on('call-error', ({ message }) => {
          connStatus.text  = message;
          connStatus.color = 'var(--lis-accent)';
          ui.connecting = false;
          socket.disconnect();
          socket = null;
          localStream?.getTracks().forEach(t => t.stop());
          localStream = null;
          showToast('error', 'Call-Fehler', message);
        });

        socket.on('call-joined', async ({ users, isFirst }) => {
          ui.connecting    = false;
          ui.showConnection = false;
          call.active = true;

          sysMsg('Du bist dem Call beigetreten ✓');
          showToast('success', 'Verbunden', 'Du bist im Call');

          // Register self
          participants[mySocketId] = {
            id: mySocketId, username: myUsername, profilePic: myProfilePic,
            isLocal: true, muted: false, sharing: false, speaking: false,
          };
          addTile(mySocketId);

          // Call timer
          callStart = Date.now();
          timerInt = setInterval(() => {
            callDuration.value = formatDuration(Math.floor((Date.now() - callStart) / 1000));
          }, 1000);

          // DBD queue auto-refresh
          fetchQueue();
          queueInt = setInterval(fetchQueue, 120_000);

          // Stats polling
          statsInt = setInterval(collectStats, 3000);

          // VAD
          setupVAD();

          // Second person creates offer
          if (!isFirst) {
            await ensurePeer();
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket.emit('signal', { type: 'offer', sdp: offer.sdp });
          }
        });

        socket.on('peer-joined', ({ id, username, profilePic }) => {
          participants[id] = {
            id, username, profilePic, isLocal: false,
            muted: false, sharing: false, speaking: false,
          };
          addTile(id);
          sysMsg(`${username} ist beigetreten`);
          showToast('info', 'Peer', `${username} ist beigetreten`);
        });

        socket.on('signal', async (data) => {
          try {
            if (data.type === 'offer') {
              // Renegotiation or initial offer
              if (!pc || pc.connectionState === 'closed' || pc.connectionState === 'failed') {
                await ensurePeer();
              }
              await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              socket.emit('signal', { type: 'answer', sdp: answer.sdp });
              call.connected = true;
            } else if (data.type === 'answer') {
              if (pc?.signalingState === 'have-local-offer') {
                await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
                call.connected = true;
              }
            } else if (data.type === 'candidate') {
              if (pc && pc.remoteDescription) {
                await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
              }
            }
          } catch (e) {
            console.warn('Signal-Fehler:', e);
          }
        });

        socket.on('peer-left', ({ id, username }) => {
          call.connected = false;
          removePeerUI(id);
          sysMsg(`${username} hat den Call verlassen`);
          showToast('warn', 'Peer getrennt', username);
          pc?.close();
          pc = null;
          if (isScreenSharing.value) stopScreenShare();
          netQuality.value = 'unknown';
          clearStats();
        });

        socket.on('chat-message', (msg) => {
          const isOwn = msg.id === mySocketId;
          chatMessages.value.push({ ...msg, isOwn, type: 'chat' });
          if (!isOwn) unreadCount.value++;
          scrollChat();
          // Floating emoji if the message is a single emoji
          if (!isOwn && isEmojiOnly(msg.text)) spawnEmoji(msg.text);
        });

        socket.on('screen-share-stopped', () => {
          const peerId = Object.keys(participants).find(id => id !== mySocketId);
          if (peerId) {
            participants[peerId].sharing = false;
            document.getElementById(`vid-wrap-${peerId}-screen`)?.remove();
          }
          sysMsg('Bildschirm-Share beendet');
          showToast('info', 'Screen Share', 'Peer hat beendet');
        });

        socket.on('disconnect', () => { call.connected = false; });
      }

      // ── WebRTC ─────────────────────────────────────────────────
      async function ensurePeer() {
        if (pc && pc.connectionState !== 'closed' && pc.connectionState !== 'failed') return;

        pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

        // Add local mic
        if (localStream) {
          localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
        }

        pc.onicecandidate = ({ candidate }) => {
          if (candidate) socket?.emit('signal', { type: 'candidate', candidate });
        };

        pc.onconnectionstatechange = () => {
          const state = pc?.connectionState;
          if (state === 'connected')   { call.connected = true;  netQuality.value = 'good'; }
          if (state === 'disconnected'){ call.connected = false; netQuality.value = 'medium'; }
          if (state === 'failed')      { call.connected = false; netQuality.value = 'poor'; }
        };

        pc.onnegotiationneeded = async () => {
          // Only re-offer if we are the "active" side (second person who joined)
          if (!call.active) return;
          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket?.emit('signal', { type: 'offer', sdp: offer.sdp });
          } catch {}
        };

        pc.ontrack = handleRemoteTrack;
      }

      function handleRemoteTrack(event) {
        const track  = event.track;
        const stream = event.streams[0];
        const peerId = Object.keys(participants).find(id => id !== mySocketId);

        if (track.kind === 'audio') {
          ensureRemoteAudio(stream);
          return;
        }

        // Video track
        if (!stream || !peerId) return;
        const isScreen = track.label.toLowerCase().includes('screen') ||
                         track.label.toLowerCase().includes('window') ||
                         track.label.toLowerCase().includes('desktop') ||
                         stream.getVideoTracks().length > 1;  // second video = screen
        const suffix = isScreen ? 'screen' : 'cam';
        const wrapId = `vid-wrap-${peerId}-${suffix}`;
        if (document.getElementById(wrapId)) return;

        const wrap = document.createElement('div');
        wrap.className = 'video-container';
        wrap.id = wrapId;
        wrap.addEventListener('contextmenu', (e) => { e.preventDefault(); showCtx(e, peerId); });
        wrap.addEventListener('dblclick', () => toggleFullscreen(wrap));

        const vid = document.createElement('video');
        vid.id = `vid-${peerId}-${suffix}`;
        vid.autoplay = true;
        vid.playsInline = true;
        vid.srcObject = stream;

        const lbl = document.createElement('div');
        lbl.className = 'video-label';
        lbl.textContent = isScreen ? `🖥️ ${participants[peerId]?.username ?? 'Peer'}` : (participants[peerId]?.username ?? 'Peer');

        const hint = document.createElement('div');
        hint.className = 'fullscreen-hint';
        hint.textContent = 'Doppelklick für Vollbild';

        wrap.appendChild(vid);
        wrap.appendChild(lbl);
        wrap.appendChild(hint);
        document.getElementById('video-grid').appendChild(wrap);

        if (participants[peerId]) participants[peerId].sharing = isScreen || participants[peerId].sharing;

        track.onended = () => {
          wrap.remove();
          if (participants[peerId]) participants[peerId].sharing = false;
        };
      }

      function ensureRemoteAudio(stream) {
        if (!remoteAudio) {
          remoteAudio = document.createElement('audio');
          remoteAudio.autoplay = true;
          document.body.appendChild(remoteAudio);
        }
        remoteAudio.srcObject = stream;
        remoteAudio.volume = Math.min(remoteVolume, 1);
        if (selectedOutput.value && remoteAudio.setSinkId) {
          remoteAudio.setSinkId(selectedOutput.value).catch(() => {});
        }
      }

      function removePeerUI(id) {
        clearInterval(tileUpdateInts[id]);
        delete tileUpdateInts[id];
        document.getElementById(`tile-${id}`)?.remove();
        document.getElementById(`vid-wrap-${id}-screen`)?.remove();
        document.getElementById(`vid-wrap-${id}-cam`)?.remove();
        delete participants[id];
      }

      // ── VAD ────────────────────────────────────────────────────
      function setupVAD() {
        clearInterval(vadInt);
        if (!localStream) return;
        try {
          const ac = new AudioContext();
          const src = ac.createMediaStreamSource(localStream);
          const an  = ac.createAnalyser();
          an.fftSize = 256;
          src.connect(an);
          const buf = new Uint8Array(an.frequencyBinCount);
          vadInt = setInterval(() => {
            an.getByteFrequencyData(buf);
            const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
            if (participants[mySocketId]) participants[mySocketId].speaking = avg > 20;
          }, 150);
        } catch {}
      }

      // ── Screen Share ───────────────────────────────────────────
      async function startScreenShare() {
        try {
          screenStream = await navigator.mediaDevices.getDisplayMedia({
            video: {
              frameRate: { ideal: QUALITY_PRESETS[currentQuality.value].fps },
              width:     { ideal: QUALITY_PRESETS[currentQuality.value].width },
              height:    { ideal: QUALITY_PRESETS[currentQuality.value].height },
            },
            audio: true,
          });
        } catch (e) {
          if (e.name !== 'NotAllowedError') showToast('error', 'Screen Share', e.message);
          return;
        }

        const videoTrack = screenStream.getVideoTracks()[0];
        if (!videoTrack) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; return; }

        await ensurePeer();

        // Add video track
        pc.addTrack(videoTrack, screenStream);

        // Handle audio from screen capture
        const audioTrack = screenStream.getAudioTracks()[0];
        if (audioTrack) {
          const label = audioTrack.label.toLowerCase();
          // Per-app audio: Windows per-process capture (no echo)
          const isPerApp = label.includes('window') || label.includes('application') ||
                           label.includes('web contents') || label.includes('tab');
          if (isPerApp || !remoteAudio?.srcObject) {
            pc.addTrack(audioTrack, screenStream);
            console.log('Screen Share: Per-App-Audio ✓ (kein Echo)');
          } else {
            // System loopback → software AEC
            const { processedStream } = createLoopbackAEC(screenStream, remoteAudio.srcObject);
            aecTrack = processedStream.getAudioTracks()[0];
            if (aecTrack) pc.addTrack(aecTrack, processedStream);
            console.log('Screen Share: Software-AEC aktiv');
          }
        }

        isScreenSharing.value = true;
        if (participants[mySocketId]) participants[mySocketId].sharing = true;

        // Local preview (muted to avoid feedback)
        const wrapId = 'vid-wrap-local-screen';
        if (!document.getElementById(wrapId)) {
          const wrap = document.createElement('div');
          wrap.className = 'video-container';
          wrap.id = wrapId;

          const vid = document.createElement('video');
          vid.id = 'vid-local-screen';
          vid.autoplay = true;
          vid.playsInline = true;
          vid.muted = true;
          vid.srcObject = screenStream;

          const lbl = document.createElement('div');
          lbl.className = 'video-label';
          lbl.textContent = `🖥️ ${myUsername} (Du)`;

          wrap.appendChild(vid);
          wrap.appendChild(lbl);
          document.getElementById('video-grid').appendChild(wrap);
        }

        videoTrack.onended = () => stopScreenShare();
        showToast('success', 'Screen Share', 'Bildschirm wird geteilt');
      }

      async function stopScreenShare() {
        if (!isScreenSharing.value) return;
        isScreenSharing.value = false;
        if (participants[mySocketId]) participants[mySocketId].sharing = false;

        document.getElementById('vid-wrap-local-screen')?.remove();

        // Remove screen share tracks from peer connection
        if (pc && screenStream) {
          const origTracks = new Set(screenStream.getTracks());
          const savedAecTrack = aecTrack;
          pc.getSenders()
            .filter(s => s.track && (origTracks.has(s.track) || s.track === savedAecTrack))
            .forEach(s => { try { pc.removeTrack(s); } catch {} });
        }

        // Clean up AEC
        if (aecCtx) {
          try { await aecCtx.close(); } catch {}
          aecCtx = null;
        }
        aecTrack = null;

        screenStream?.getTracks().forEach(t => t.stop());
        screenStream = null;

        socket?.emit('screen-share-stopped');
        showToast('info', 'Screen Share', 'Beendet');
      }

      // ── Loopback AEC ───────────────────────────────────────────
      function createLoopbackAEC(loopbackStream, referenceStream) {
        const RATE          = 48000;
        const DELAY_SAMPLES = Math.round(0.04 * RATE); // 40ms WASAPI latency
        const CANCEL_GAIN   = 0.85;

        aecCtx = new AudioContext({ sampleRate: RATE });
        const loopSrc = aecCtx.createMediaStreamSource(loopbackStream);
        const refSrc  = aecCtx.createMediaStreamSource(referenceStream);
        const dest    = aecCtx.createMediaStreamDestination();

        const delayBuf = new Float32Array(DELAY_SAMPLES + 4096);
        let writePos = 0;

        const proc   = aecCtx.createScriptProcessor(4096, 2, 1);
        const merger = aecCtx.createChannelMerger(2);
        loopSrc.connect(merger, 0, 0);
        refSrc.connect(merger,  0, 1);
        merger.connect(proc);
        proc.connect(dest);

        proc.onaudioprocess = (e) => {
          const loop = e.inputBuffer.getChannelData(0);
          const ref  = e.inputBuffer.getChannelData(1);
          const out  = e.outputBuffer.getChannelData(0);
          for (let i = 0; i < loop.length; i++) {
            delayBuf[(writePos + i) % delayBuf.length] = ref[i];
          }
          for (let i = 0; i < loop.length; i++) {
            const rp = (writePos + i + delayBuf.length - DELAY_SAMPLES) % delayBuf.length;
            out[i] = loop[i] - delayBuf[rp] * CANCEL_GAIN;
          }
          writePos = (writePos + loop.length) % delayBuf.length;
        };

        return { processedStream: dest.stream };
      }

      // ── Mute / PTT ─────────────────────────────────────────────
      function toggleMute() {
        if (pttEnabled.value) {
          // In PTT mode, toggling mute disables PTT first
          togglePTT();
          return;
        }
        isMuted.value = !isMuted.value;
        applyMicEnabled(!isMuted.value);
        if (participants[mySocketId]) participants[mySocketId].muted = isMuted.value;
        showToast(isMuted.value ? 'warn' : 'success', isMuted.value ? 'Stummgeschaltet' : 'Mikrofon aktiv');
      }

      function togglePTT() {
        pttEnabled.value = !pttEnabled.value;
        if (pttEnabled.value) {
          isMuted.value = true;
          applyMicEnabled(false);
          if (participants[mySocketId]) participants[mySocketId].muted = true;
          showToast('warn', 'Push-to-Talk AN', 'Leertaste halten zum Sprechen');
        } else {
          isMuted.value = false;
          applyMicEnabled(true);
          if (participants[mySocketId]) participants[mySocketId].muted = false;
          showToast('success', 'Push-to-Talk AUS', 'Mikrofon immer aktiv');
        }
      }

      function applyMicEnabled(enabled) {
        localStream?.getAudioTracks().forEach(t => { t.enabled = enabled; });
      }

      function onKeyDown(e) {
        if (!pttEnabled.value || e.code !== 'Space' || e.repeat) return;
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        e.preventDefault();
        pttActive.value = true;
        applyMicEnabled(true);
      }

      function onKeyUp(e) {
        if (!pttEnabled.value || e.code !== 'Space') return;
        pttActive.value = false;
        applyMicEnabled(false);
      }

      // ── Chat ───────────────────────────────────────────────────
      function sendMessage() {
        const text = chatInput.value.trim();
        if (!text || !socket) return;
        socket.emit('chat-message', text);
        chatInput.value = '';
        unreadCount.value = 0;
      }

      // ── Emoji Reactions ────────────────────────────────────────
      function sendEmoji(emoji) {
        ui.showEmoji = false;
        socket?.emit('chat-message', emoji);
        spawnEmoji(emoji);
      }

      function spawnEmoji(emoji) {
        const id = Date.now() + Math.random();
        const x  = 5 + Math.random() * 85;
        activeEmojis.value.push({ id, emoji, x });
        setTimeout(() => {
          activeEmojis.value = activeEmojis.value.filter(e => e.id !== id);
        }, 3200);
      }

      function isEmojiOnly(str) {
        return /^[\u{1F300}-\u{1FFFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}❤👍💀🌊✨]+$/u.test(str.trim());
      }

      // ── Quality ────────────────────────────────────────────────
      async function setQuality(key) {
        currentQuality.value = key;
        ui.showQuality = false;
        if (screenStream) {
          const vt = screenStream.getVideoTracks()[0];
          if (vt) {
            const q = QUALITY_PRESETS[key];
            try { await vt.applyConstraints({ frameRate: q.fps, width: { ideal: q.width }, height: { ideal: q.height } }); } catch {}
          }
        }
        showToast('info', 'Qualität', `${QUALITY_PRESETS[key].label} · ${QUALITY_PRESETS[key].fps}fps`);
      }

      // ── Context Menu ───────────────────────────────────────────
      function showCtx(event, targetId) {
        ctx.visible  = true;
        ctx.x        = Math.min(event.clientX, window.innerWidth  - 230);
        ctx.y        = Math.min(event.clientY, window.innerHeight - 180);
        ctx.targetId = targetId;
        ctx.volume   = Math.round(remoteVolume * 100);
      }

      function ctxFullscreen() {
        ctx.visible = false;
        const el = document.querySelector(`#vid-wrap-${ctx.targetId}-screen video`) ||
                   document.querySelector(`#vid-wrap-${ctx.targetId}-cam video`);
        el?.requestFullscreen?.();
      }

      function ctxSetVolume() {
        remoteVolume = ctx.volume / 100;
        if (remoteAudio) remoteAudio.volume = Math.min(remoteVolume, 1);
      }

      function toggleFullscreen(wrap) {
        if (!document.fullscreenElement) wrap.requestFullscreen?.();
        else document.exitFullscreen?.();
      }

      // ── Stats ──────────────────────────────────────────────────
      async function collectStats() {
        if (!pc) return;
        try {
          const report = await pc.getStats();
          report.forEach(s => {
            if (s.type === 'inbound-rtp' && s.kind === 'video') {
              stats.res = `${s.frameWidth ?? '?'}×${s.frameHeight ?? '?'}`;
              stats.fps = `${Math.round(s.framesPerSecond ?? 0)}`;
            }
            if (s.type === 'candidate-pair' && s.nominated) {
              if (s.currentRoundTripTime != null) {
                stats.rtt = `${Math.round(s.currentRoundTripTime * 1000)} ms`;
                const rtt = s.currentRoundTripTime * 1000;
                netQuality.value = rtt < 80 ? 'good' : rtt < 200 ? 'medium' : 'poor';
              }
              if (s.availableOutgoingBitrate != null) {
                stats.bitrate = `${Math.round(s.availableOutgoingBitrate / 1000)} kbps`;
              }
            }
          });
        } catch {}
      }

      function clearStats() {
        stats.res = stats.fps = stats.bitrate = stats.rtt = '—';
      }

      // ── DBD Queue ──────────────────────────────────────────────
      async function fetchQueue() {
        queue.loading = true;
        queue.error   = '';
        try {
          const res  = await fetch('/api/killer-queue');
          const data = await res.json();
          if (data.error) {
            queue.error = data.error;
            queue.time  = '';
          } else {
            queue.time  = data.killerQueue;
            queue.mode  = data.mode ?? '';
            queue.error = '';
          }
        } catch {
          queue.error = 'Nicht erreichbar';
          queue.time  = '';
        } finally {
          queue.loading = false;
        }
      }

      // ── Participant Tiles (DOM) ─────────────────────────────────
      function addTile(id) {
        const p = participants[id];
        if (!p) return;
        document.getElementById(`tile-${id}`)?.remove();

        const tile = document.createElement('div');
        tile.id        = `tile-${id}`;
        tile.className = 'user-tile';

        const ring = document.createElement('div');
        ring.className = 'speaking-ring';

        const avatar = document.createElement('div');
        avatar.className = 'avatar';
        if (p.profilePic) {
          const img = new Image();
          img.src = p.profilePic;
          img.alt = p.username;
          img.onerror = () => { avatar.textContent = p.username[0]?.toUpperCase() ?? '?'; };
          avatar.appendChild(img);
        } else {
          avatar.textContent = p.username[0]?.toUpperCase() ?? '?';
        }

        const name = document.createElement('div');
        name.className   = 'tile-name';
        name.textContent = p.username + (p.isLocal ? ' (Du)' : '');

        const badges = document.createElement('div');
        badges.className = 'tile-badges';

        tile.appendChild(ring);
        tile.appendChild(avatar);
        tile.appendChild(name);
        tile.appendChild(badges);
        document.getElementById('video-grid').appendChild(tile);

        // Live update tile state
        tileUpdateInts[id] = setInterval(() => {
          const cur = participants[id];
          if (!cur) { clearInterval(tileUpdateInts[id]); return; }
          tile.classList.toggle('speaking', !!cur.speaking);
          let html = '';
          if (cur.muted)   html += '<div class="tile-badge">🔇</div>';
          if (cur.sharing) html += '<div class="tile-badge">🖥️</div>';
          badges.innerHTML = html;
        }, 200);
      }

      // ── Leave ──────────────────────────────────────────────────
      async function leaveCall() {
        clearInterval(timerInt);
        clearInterval(statsInt);
        clearInterval(queueInt);
        clearInterval(vadInt);
        Object.keys(tileUpdateInts).forEach(k => clearInterval(tileUpdateInts[k]));
        tileUpdateInts = {};

        callDuration.value = '';

        if (isScreenSharing.value) await stopScreenShare();

        pc?.close();
        pc = null;

        localStream?.getTracks().forEach(t => t.stop());
        localStream = null;

        if (remoteAudio) { remoteAudio.remove(); remoteAudio = null; }

        socket?.disconnect();
        socket = null;

        const grid = document.getElementById('video-grid');
        if (grid) grid.innerHTML = '';

        Object.keys(participants).forEach(k => delete participants[k]);

        call.active    = false;
        call.connected = false;
        isMuted.value  = false;
        pttEnabled.value = false;
        pttActive.value  = false;
        netQuality.value = 'unknown';
        clearStats();
        chatMessages.value = [];
        unreadCount.value  = 0;
        mySocketId = null;
      }

      // ── Lifecycle ──────────────────────────────────────────────
      onMounted(() => {
        // Resolve toast service (must be after mount so $toast is injected)
        const inst = getCurrentInstance();
        _toastFn = inst?.appContext?.config?.globalProperties?.$toast ?? null;

        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('keyup',   onKeyUp);
        document.addEventListener('click', () => { ctx.visible = false; });

        // Hide logo image errors silently
        document.querySelectorAll('img[onerror]');
      });

      onUnmounted(() => {
        document.removeEventListener('keydown', onKeyDown);
        document.removeEventListener('keyup',   onKeyUp);
        leaveCall();
      });

      // ── Expose to template ─────────────────────────────────────
      return {
        // State
        ui, queue, participants, chatMessages, chatInput,
        call, isMuted, pttEnabled, pttActive, isScreenSharing,
        callDuration, netQuality, activeEmojis, emojis,
        qualityPresets, currentQuality, stats, ctx,
        unreadCount, serverUrl, connStatus,
        selectedInput, selectedOutput, audioInputs, audioOutputs,
        profilePics, chatEl,
        // Computed
        participantCount, qualityLabel,
        // Methods
        selectProfile, openConnectionModal, connectToServer, applyAudioDevices,
        ctxFullscreen, ctxSetVolume, fetchQueue, sendMessage,
        toggleMute, togglePTT, startScreenShare, stopScreenShare,
        sendEmoji, setQuality, openAudioDevices, leaveCall,
      };
    },
  };

  // ── Bootstrap ──────────────────────────────────────────────────
  const vueApp = createApp(App);

  if (PrimeVue) {
    vueApp.use(PrimeVue, { ripple: true });
  } else {
    console.warn('PrimeVue config not found — UI may be unstyled');
  }

  vueApp.use(ToastService);

  // Register components
  const components = {
    'p-toast':     PvToast,
    'p-dialog':    PvDialog,
    'p-button':    PvButton,
    'p-inputtext': PvInputText,
    'p-slider':    PvSlider,
  };
  for (const [name, comp] of Object.entries(components)) {
    if (comp) vueApp.component(name, comp);
    else console.warn(`PrimeVue component "${name}" not found`);
  }

  if (PvTooltip && typeof PvTooltip === 'object' && PvTooltip.beforeMount) {
    vueApp.directive('tooltip', PvTooltip);
  }

  vueApp.mount('#app');

})();

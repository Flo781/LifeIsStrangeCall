const { app, BrowserWindow, session, desktopCapturer, ipcMain, systemPreferences, dialog } = require("electron");
const path = require("path");
const { execSync, exec } = require("child_process");
const fs = require("fs");
const os = require("os");

require("./server.js");

let mainWindow;
let pickerWindow;

// ---- BlackHole Hilfsfunktionen ----

function isBlackHoleInstalled() {
  try {
    const result = execSync("system_profiler SPAudioDataType 2>/dev/null || true").toString();
    return result.toLowerCase().includes("blackhole");
  } catch {
    return false;
  }
}

function installPkg(pkgPath) {
  return new Promise((resolve, reject) => {
    // Pfad für AppleScript korrekt escapen (einfache Anführungszeichen müssen escaped werden)
    const escapedPath = pkgPath.replace(/'/g, "'\\''");
    const script = `do shell script "installer -pkg '${escapedPath}' -target /" with administrator privileges`;
    exec(`osascript -e ${JSON.stringify(script)}`, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve();
    });
  });
}

async function installBlackHoleIfNeeded() {
  if (process.platform !== "darwin") return;
  if (isBlackHoleInstalled()) {
    console.log("BlackHole bereits installiert ✓");
    return;
  }

  console.log("BlackHole nicht gefunden → starte automatische Installation...");

  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "info",
    title: "System-Audio einrichten",
    message: "Für System-Audio beim Bildschirm teilen wird BlackHole benötigt.",
    detail: "BlackHole ist ein kostenloser Audio-Treiber der einmalig installiert wird.\nDu wirst einmalig nach deinem Mac-Passwort gefragt.\n\nDie Installation dauert ca. 10 Sekunden.",
    buttons: ["Jetzt installieren", "Überspringen"],
    defaultId: 0,
    cancelId: 1,
  });

  if (response === 1) {
    console.log("BlackHole Installation übersprungen");
    return;
  }

  // Progress Fenster anzeigen
  const progressWin = new BrowserWindow({
    width: 420,
    height: 160,
    resizable: false,
    minimizable: false,
    maximizable: false,
    modal: true,
    parent: mainWindow,
    frame: false,
    webPreferences: { contextIsolation: false, nodeIntegration: true },
    backgroundColor: "#1a1a2e",
  });

  progressWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`
    <html><head><meta charset="UTF-8"><style>
      * { margin:0; padding:0; box-sizing:border-box; }
      body { font-family: 'Segoe UI', sans-serif; background: #1a1a2e; color: #e0e0e0;
             display: flex; flex-direction: column; align-items: center;
             justify-content: center; height: 100vh; gap: 12px; }
      h3 { color: #c89b7b; font-size: 15px; }
      p  { font-size: 12px; color: #aaa; }
      .bar-wrap { width: 320px; height: 6px; background: #2a2a3e; border-radius: 3px; }
      .bar { height: 6px; background: #c89b7b; border-radius: 3px;
             animation: load 8s linear forwards; }
      @keyframes load { from { width: 0% } to { width: 95% } }
    </style></head><body>
      <h3>🔧 BlackHole wird installiert...</h3>
      <div class="bar-wrap"><div class="bar"></div></div>
      <p>Bitte Mac-Passwort eingeben wenn gefragt...</p>
    </body></html>
  `));

  // .pkg direkt aus dem App-Bundle — kein Internet nötig!
  // Im Dev-Modus: assets/installers/, im gebauten Build: resources/installers/
  const bundledPkg = app.isPackaged
    ? path.join(process.resourcesPath, "installers", "BlackHole2ch.pkg")
    : path.join(__dirname, "assets", "installers", "BlackHole2ch.pkg");

  try {
    if (!fs.existsSync(bundledPkg)) {
      throw new Error("BlackHole2ch.pkg nicht im App-Bundle gefunden.");
    }

    await installPkg(bundledPkg);

    if (!progressWin.isDestroyed()) progressWin.close();

    // Kein Neustart nötig! Einfach Erfolgsmeldung anzeigen
    await dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "✅ Installation erfolgreich!",
      message: "BlackHole wurde erfolgreich installiert!",
      detail: "System-Audio beim Bildschirm teilen ist jetzt verfügbar.\nDu kannst sofort loslegen!",
      buttons: ["OK"],
    });

  } catch (err) {
    console.error("BlackHole Installation fehlgeschlagen:", err);
    if (!progressWin.isDestroyed()) progressWin.close();

    await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "Installation fehlgeschlagen",
      message: "BlackHole konnte nicht automatisch installiert werden.",
      detail: "Fehler: " + err.message,
      buttons: ["OK"],
    });
  }
}

// ---- Hauptfenster ----

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "LifeIsStrangeCall",
    icon: path.join(__dirname, "assets/icons/Adobe Express - file.png"),
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      webSecurity: false,
    },
    backgroundColor: "#1a1a2e",
    show: false,
  });

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(true);
  });
  session.defaultSession.setPermissionCheckHandler(() => true);

  // Screen Share Handler mit eigenem Picker
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    }).then((sources) => {
      // BlackHole direkt über system_profiler prüfen (funktioniert auch ohne Neustart)
      const blackHoleInstalled = isBlackHoleInstalled();
      openPickerWindow(sources, callback, blackHoleInstalled);
    }).catch(err => {
      console.error("desktopCapturer Fehler:", err);
      callback({});
    });
  }, { useSystemPicker: false });

  if (process.platform === "darwin") {
    systemPreferences.getMediaAccessStatus("screen");
  }

  setTimeout(() => {
    mainWindow.loadURL("http://localhost:3000");
  }, 1500);

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    // BlackHole nach kurzem Delay prüfen (Fenster muss erst geladen sein)
    setTimeout(() => installBlackHoleIfNeeded(), 2000);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    require("electron").shell.openExternal(url);
    return { action: "deny" };
  });
}

// ---- Screen Share Picker ----

function openPickerWindow(sources, callback, blackHoleInstalled) {
  if (pickerWindow && !pickerWindow.isDestroyed()) pickerWindow.destroy();

  const isMac = process.platform === "darwin";
  const isWin = process.platform === "win32";

  pickerWindow = new BrowserWindow({
    width: 800,
    height: 620,
    title: "Bildschirm oder Fenster wählen",
    resizable: false,
    minimizable: false,
    maximizable: false,
    modal: true,
    parent: mainWindow,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
    },
    backgroundColor: "#1a1a2e",
  });

  pickerWindow.setMenu(null);

  const sourcesJson = JSON.stringify(sources.map(s => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
    isScreen: s.id.startsWith("screen:"),
  })));

  const macAudioHint = isMac ? `
    <div id="macAudioHint" style="margin-top:8px;padding:10px 14px;background:#16213e;
      border-left:3px solid #c89b7b;border-radius:6px;font-size:12px;color:#bbb;line-height:1.6;">
      <span id="audioHintText">${blackHoleInstalled ? '✅ BlackHole erkannt — System-Audio wird übertragen!' : '⚠️ BlackHole nicht erkannt. Starte die App neu falls du es gerade installiert hast.'}</span>
    </div>` : "";

  const winAudioHint = isWin ? `
    <div style="margin-top:8px;padding:10px 14px;background:#16213e;
      border-left:3px solid #4caf50;border-radius:6px;font-size:12px;color:#bbb;line-height:1.6;">
      ✅ Windows: System-Audio wird automatisch mitübertragen
    </div>` : "";

  const pickerHTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{font-family:'Segoe UI',sans-serif;background:#1a1a2e;color:#e0e0e0;padding:20px;user-select:none;}
    h2{font-size:16px;margin-bottom:6px;color:#c89b7b;}
    .subtitle{font-size:12px;color:#888;margin-bottom:14px;}
    .section-title{font-size:11px;text-transform:uppercase;color:#888;letter-spacing:1px;margin:14px 0 8px;}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px;max-height:220px;overflow-y:auto;padding-right:4px;}
    .grid::-webkit-scrollbar{width:6px;} .grid::-webkit-scrollbar-track{background:#0d0d1a;}
    .grid::-webkit-scrollbar-thumb{background:#c89b7b55;border-radius:3px;}
    .source{background:#16213e;border:2px solid transparent;border-radius:10px;padding:8px;cursor:pointer;transition:all 0.15s;text-align:center;}
    .source:hover{border-color:#c89b7b88;background:#1e2d4d;}
    .source.selected{border-color:#c89b7b;background:#1e2d4d;}
    .source img{width:100%;height:90px;object-fit:cover;border-radius:6px;background:#0d0d1a;}
    .source .name{font-size:11px;margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#ccc;}
    .audio-row{margin-top:12px;display:flex;align-items:center;gap:10px;font-size:13px;color:#ccc;}
    .audio-row input[type=checkbox]{width:16px;height:16px;accent-color:#c89b7b;cursor:pointer;}
    .buttons{margin-top:14px;display:flex;justify-content:flex-end;gap:10px;}
    button{padding:8px 20px;border:none;border-radius:8px;font-size:13px;cursor:pointer;font-family:inherit;}
    #cancelBtn{background:#2a2a3e;color:#aaa;} #cancelBtn:hover{background:#333355;}
    #shareBtn{background:#c89b7b;color:#1a1a2e;font-weight:bold;} #shareBtn:hover{background:#d4aa8a;}
    #shareBtn:disabled{background:#555;color:#888;cursor:not-allowed;}
    .empty{color:#555;font-size:12px;padding:8px 0;}
  </style></head><body>
  <h2>🖥️ Bildschirm oder Fenster teilen</h2>
  <p class="subtitle">Wähle was du teilen möchtest</p>
  <div class="section-title">Bildschirme</div>
  <div class="grid" id="screenGrid"></div>
  <div class="section-title">Fenster / Anwendungen</div>
  <div class="grid" id="windowGrid"></div>
  <div class="audio-row">
    <input type="checkbox" id="audioCheck" ${(isMac && blackHoleInstalled) ? 'checked' : (isWin ? 'checked' : 'disabled')}>
    <label for="audioCheck">System-Audio mitübertragen</label>
  </div>
  ${macAudioHint}
  ${winAudioHint}
  <div class="buttons">
    <button id="cancelBtn">Abbrechen</button>
    <button id="shareBtn" disabled>Teilen</button>
  </div>
  <script>
    const { ipcRenderer } = require('electron');
    const sources = ${sourcesJson};
    const isMac = ${isMac};
    const isWin = ${isWin};
    let selectedId = null;
    let blackHoleDeviceId = null;

    async function checkBlackHole() {
      if (!isMac) return;
      const hint = document.getElementById('audioHintText');
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {});
        const devices = await navigator.mediaDevices.enumerateDevices();
        const bh = devices.find(d => d.kind === 'audioinput' && d.label.toLowerCase().includes('blackhole'));
        if (bh) {
          blackHoleDeviceId = bh.deviceId;
          hint.innerHTML = '✅ BlackHole erkannt — System-Audio wird übertragen!';
          hint.parentElement.style.borderColor = '#4caf50';
        } else {
          hint.innerHTML = '⚠️ BlackHole nicht erkannt. Starte die App neu falls du es gerade installiert hast.';
          hint.parentElement.style.borderColor = '#e57373';
          document.getElementById('audioCheck').checked = false;
          document.getElementById('audioCheck').disabled = true;
        }
      } catch(e) {
        hint.innerHTML = '⚠️ Audio-Geräte konnten nicht geprüft werden.';
      }
    }

    function renderSources() {
      const screenGrid = document.getElementById('screenGrid');
      const windowGrid = document.getElementById('windowGrid');
      const screens = sources.filter(s => s.isScreen);
      const windows = sources.filter(s => !s.isScreen);
      if (!screens.length) screenGrid.innerHTML = '<p class="empty">Keine Bildschirme gefunden</p>';
      screens.forEach(s => screenGrid.appendChild(createCard(s)));
      if (!windows.length) windowGrid.innerHTML = '<p class="empty">Keine Fenster gefunden</p>';
      windows.forEach(s => windowGrid.appendChild(createCard(s)));
    }

    function createCard(s) {
      const div = document.createElement('div');
      div.className = 'source';
      div.innerHTML = \`<img src="\${s.thumbnail}" onerror="this.style.background='#0d0d1a'">
        <div class="name" title="\${s.name}">\${s.name}</div>\`;
      div.onclick = () => {
        document.querySelectorAll('.source').forEach(el => el.classList.remove('selected'));
        div.classList.add('selected');
        selectedId = s.id;
        document.getElementById('shareBtn').disabled = false;
      };
      div.ondblclick = () => { selectedId = s.id; share(); };
      return div;
    }

    function share() {
      if (!selectedId) return;
      ipcRenderer.send('picker-selected', {
        sourceId: selectedId,
        withAudio: document.getElementById('audioCheck').checked,
        blackHoleDeviceId
      });
    }

    document.getElementById('shareBtn').onclick = share;
    document.getElementById('cancelBtn').onclick = () => ipcRenderer.send('picker-cancelled');
    renderSources();
    checkBlackHole();
  </script></body></html>`;

  pickerWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(pickerHTML));

  ipcMain.once("picker-selected", (event, { sourceId, withAudio, blackHoleDeviceId }) => {
    const source = sources.find(s => s.id === sourceId);
    if (source) {
      // FIX: Kein "loopback" mehr — das wirft einen Fehler in neuem Electron!
      // Windows: audio:true reicht, Electron handled das intern über getDisplayMedia
      // macOS: BlackHole deviceId separat an client.js übergeben
      let audioMode = false;
      if (withAudio) {
        if (process.platform === "win32") {
          audioMode = true; // Windows: einfach true, kein "loopback"
        } else if (process.platform === "darwin" && blackHoleDeviceId) {
          mainWindow.webContents.executeJavaScript(
            `window._blackHoleDeviceId = ${JSON.stringify(blackHoleDeviceId)};`
          ).catch(() => {});
        }
      }
      callback({ video: source, audio: audioMode });
    } else {
      callback({});
    }
    if (pickerWindow && !pickerWindow.isDestroyed()) pickerWindow.close();
    pickerWindow = null;
  });

  ipcMain.once("picker-cancelled", () => {
    if (pickerWindow && !pickerWindow.isDestroyed()) pickerWindow.destroy();
    pickerWindow = null;
  });

  pickerWindow.on("closed", () => {
    ipcMain.removeAllListeners("picker-selected");
    ipcMain.removeAllListeners("picker-cancelled");
    pickerWindow = null;
  });
}

// ---- IPC: Audio-Geräte vom Renderer anfragen ----
ipcMain.handle("get-audio-devices", async () => {
  // Renderer kann das selbst — wir geben nur das Signal
  return true;
});

// ---- App Start ----

// macOS: App entsperrt sich beim ersten Start selbst
function removeSelfQuarantine() {
  if (process.platform !== "darwin") return;
  try {
    const appPath = app.getPath("exe").split(".app/")[0] + ".app";
    execSync(`xattr -rd com.apple.quarantine "${appPath}" 2>/dev/null || true`);
    console.log("Quarantine entfernt ✓");
  } catch (e) {
    // Kein Problem wenn es fehlschlägt
  }
}

app.whenReady().then(() => {
  removeSelfQuarantine();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

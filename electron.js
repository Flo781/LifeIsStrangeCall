const {
  app, BrowserWindow, session, desktopCapturer,
  ipcMain, systemPreferences, dialog, shell
} = require("electron");
const path = require("path");
const { execSync, exec } = require("child_process");
const fs = require("fs");
const os = require("os");

// ---- Chromium-Flags für Audio & Screen Share ----
app.commandLine.appendSwitch("disable-features", "WidgetLayering,AudioServiceSandbox,WasapiRawAudioCapture");
app.commandLine.appendSwitch("disable-gpu-sandbox");
app.commandLine.appendSwitch("enable-features", "SharedArrayBuffer");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
// WasapiRawAudioCapture deaktiviert weil es mit bestimmten NVIDIA-Treibern keinen Ton liefert

require("./server.js");

let mainWindow = null;
let pickerWindow = null;

// ============================================================
// Hilfsfunktionen: BlackHole (macOS)
// ============================================================
function isBlackHoleInstalled() {
  if (process.platform !== "darwin") return false;
  try {
    const result = execSync("system_profiler SPAudioDataType 2>/dev/null || true").toString();
    return result.toLowerCase().includes("blackhole");
  } catch {
    return false;
  }
}

function installPkg(pkgPath) {
  return new Promise((resolve, reject) => {
    const escaped = pkgPath.replace(/'/g, "'\\''");
    const script = `do shell script "installer -pkg '${escaped}' -target /" with administrator privileges`;
    exec(`osascript -e ${JSON.stringify(script)}`, (err, _stdout, stderr) => {
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

  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "info",
    title: "System-Audio einrichten",
    message: "Für System-Audio beim Bildschirm teilen wird BlackHole benötigt.",
    detail: "BlackHole ist ein kostenloser Audio-Treiber der einmalig installiert wird.\nDu wirst einmalig nach deinem Mac-Passwort gefragt.",
    buttons: ["Jetzt installieren", "Überspringen"],
    defaultId: 0, cancelId: 1,
  });

  if (response === 1) return;

  const progressWin = new BrowserWindow({
    width: 420, height: 160, resizable: false, minimizable: false, maximizable: false,
    modal: true, parent: mainWindow, frame: false,
    webPreferences: { contextIsolation: false, nodeIntegration: true },
    backgroundColor: "#1a1a2e",
  });

  progressWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`
    <html><head><meta charset="UTF-8"><style>
      *{margin:0;padding:0;box-sizing:border-box;}
      body{font-family:'Segoe UI',sans-serif;background:#1a1a2e;color:#e0e0e0;
           display:flex;flex-direction:column;align-items:center;justify-content:center;
           height:100vh;gap:12px;}
      h3{color:#c89b7b;font-size:15px;} p{font-size:12px;color:#aaa;}
      .bar-wrap{width:320px;height:6px;background:#2a2a3e;border-radius:3px;}
      .bar{height:6px;background:#c89b7b;border-radius:3px;animation:load 8s linear forwards;}
      @keyframes load{from{width:0%}to{width:95%}}
    </style></head><body>
      <h3>🔧 BlackHole wird installiert...</h3>
      <div class="bar-wrap"><div class="bar"></div></div>
      <p>Bitte Mac-Passwort eingeben wenn gefragt...</p>
    </body></html>
  `));

  const bundledPkg = app.isPackaged
    ? path.join(process.resourcesPath, "installers", "BlackHole2ch.pkg")
    : path.join(__dirname, "assets", "installers", "BlackHole2ch.pkg");

  try {
    if (!fs.existsSync(bundledPkg)) throw new Error("BlackHole2ch.pkg nicht gefunden.");
    await installPkg(bundledPkg);
    if (!progressWin.isDestroyed()) progressWin.close();
    await dialog.showMessageBox(mainWindow, {
      type: "info", title: "✅ Installation erfolgreich!",
      message: "BlackHole wurde erfolgreich installiert!",
      detail: "System-Audio beim Bildschirm teilen ist jetzt verfügbar.",
      buttons: ["OK"],
    });
  } catch (err) {
    console.error("BlackHole Installation fehlgeschlagen:", err);
    if (!progressWin.isDestroyed()) progressWin.close();
    await dialog.showMessageBox(mainWindow, {
      type: "warning", title: "Installation fehlgeschlagen",
      message: "BlackHole konnte nicht automatisch installiert werden.",
      detail: "Fehler: " + err.message, buttons: ["OK"],
    });
  }
}

// ============================================================
// Lokale IP-Adressen ermitteln (für IPC)
// ============================================================
function getLocalIPs() {
  const ips = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const addr of ifaces) {
      if (addr.family === "IPv4" && !addr.internal) {
        ips.push(addr.address);
      }
    }
  }
  return ips;
}

ipcMain.handle("get-local-ips", () => getLocalIPs());

// ============================================================
// Hauptfenster erstellen
// ============================================================
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    title: "LifeIsStrangeCall",
    icon: path.join(__dirname, "assets/icons/Adobe Express - file.png"),
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      webSecurity: false,
      backgroundThrottling: false,
    },
    backgroundColor: "#1a1a2e",
    show: false,
  });

  // Alle Berechtigungen erlauben (Mikrofon, Screen, etc.)
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));
  session.defaultSession.setPermissionCheckHandler(() => true);

  // ---- Screen Share Handler (Electron 34+) ----
  // Renderers rufen getDisplayMedia() auf → dieser Handler fängt es ab
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: true,
      });

      const blackHoleInstalled = isBlackHoleInstalled();

      openPickerWindow(sources, blackHoleInstalled, (result) => {
        if (!result) { callback({}); return; }

        const selectedSource = sources.find(s => s.id === result.sourceId);
        if (!selectedSource) { callback({}); return; }

        const response = { video: selectedSource };

        // Windows: Loopback-Audio (System-Sound wird mitübertragen)
        if (result.withAudio && process.platform === "win32") {
          response.audio = "loopback";
          console.log("Screen Share: Windows Loopback-Audio aktiviert ✓");
        }
        // macOS: BlackHole wird als separates Mikrofon im Renderer verwendet
        // (BlackHole-DeviceId wird vom Picker mitgegeben)

        callback(response);
      });
    } catch (err) {
      console.error("setDisplayMediaRequestHandler Fehler:", err);
      callback({});
    }
  });

  if (process.platform === "darwin") {
    systemPreferences.getMediaAccessStatus("screen");
  }

  // 1,5s warten bis Server gestartet ist
  setTimeout(() => mainWindow.loadURL("http://localhost:3000"), 1500);

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    setTimeout(() => installBlackHoleIfNeeded(), 2000);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error("⚠️ Renderer abgestürzt!", details.reason, details.exitCode);
    dialog.showMessageBox({
      type: "error", title: "Renderer Crash",
      message: `Renderer abgestürzt: ${details.reason} (Code: ${details.exitCode})\nApp wird neu geladen...`
    }).then(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL("http://localhost:3000");
      }
    });
  });
}

// ============================================================
// Screen-Share-Picker-Fenster
// ============================================================
function openPickerWindow(sources, blackHoleInstalled, onResult) {
  if (pickerWindow && !pickerWindow.isDestroyed()) pickerWindow.destroy();

  const isMac = process.platform === "darwin";
  const isWin = process.platform === "win32";

  pickerWindow = new BrowserWindow({
    width: 820, height: 640,
    title: "Bildschirm oder Fenster wählen",
    resizable: false, minimizable: false, maximizable: false,
    modal: true, parent: mainWindow,
    webPreferences: { contextIsolation: false, nodeIntegration: true },
    backgroundColor: "#1a1a2e",
  });
  pickerWindow.setMenu(null);

  ipcMain.removeAllListeners("picker-selected");
  ipcMain.removeAllListeners("picker-cancelled");

  const sourcesJson = JSON.stringify(sources.map(s => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
    isScreen: s.id.startsWith("screen:"),
  })));

  const audioHintHtml = isMac
    ? `<div style="margin-top:8px;padding:10px 14px;background:#16213e;
         border-left:3px solid ${blackHoleInstalled ? "#4caf50" : "#e57373"};
         border-radius:6px;font-size:12px;color:#bbb;line-height:1.6;">
         ${blackHoleInstalled
           ? "✅ BlackHole erkannt — System-Audio wird übertragen!"
           : "⚠️ BlackHole nicht gefunden — kein System-Audio auf Mac möglich."}
       </div>`
    : isWin
    ? `<div style="margin-top:8px;padding:10px 14px;background:#16213e;
         border-left:3px solid #e5a823;border-radius:6px;font-size:12px;color:#bbb;line-height:1.6;">
         ⚠️ System-Audio überträgt ALLES was aus deinen Lautsprechern kommt — auch die Stimme deines Gesprächspartners.<br>
         Das führt dazu, dass sie sich selbst als Echo hören.<br>
         <strong style="color:#c89b7b;">Lösung: Kopfhörer verwenden</strong> oder System-Audio deaktivieren.
       </div>`
    : "";

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{font-family:'Segoe UI',sans-serif;background:#1a1a2e;color:#e0e0e0;
         padding:20px;user-select:none;}
    h2{font-size:16px;margin-bottom:4px;color:#c89b7b;}
    .sub{font-size:12px;color:#888;margin-bottom:14px;}
    .sec{font-size:11px;text-transform:uppercase;color:#888;letter-spacing:1px;margin:14px 0 8px;}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));
          gap:10px;max-height:220px;overflow-y:auto;padding-right:4px;}
    .grid::-webkit-scrollbar{width:6px;}
    .grid::-webkit-scrollbar-track{background:#0d0d1a;}
    .grid::-webkit-scrollbar-thumb{background:#c89b7b55;border-radius:3px;}
    .src{background:#16213e;border:2px solid transparent;border-radius:10px;
         padding:8px;cursor:pointer;transition:all 0.15s;text-align:center;}
    .src:hover{border-color:#c89b7b88;background:#1e2d4d;}
    .src.sel{border-color:#c89b7b;background:#1e2d4d;}
    .src img{width:100%;height:90px;object-fit:cover;border-radius:6px;background:#0d0d1a;}
    .src .nm{font-size:11px;margin-top:6px;overflow:hidden;text-overflow:ellipsis;
             white-space:nowrap;color:#ccc;}
    .empty{color:#555;font-size:12px;padding:8px 0;}
    .audio-row{margin-top:12px;display:flex;align-items:center;gap:10px;
               font-size:13px;color:#ccc;}
    .audio-row input[type=checkbox]{width:16px;height:16px;accent-color:#c89b7b;cursor:pointer;}
    .btns{margin-top:14px;display:flex;justify-content:flex-end;gap:10px;}
    button{padding:8px 20px;border:none;border-radius:8px;font-size:13px;
           cursor:pointer;font-family:inherit;}
    #cancelBtn{background:#2a2a3e;color:#aaa;}
    #cancelBtn:hover{background:#333355;}
    #shareBtn{background:#c89b7b;color:#1a1a2e;font-weight:bold;}
    #shareBtn:hover{background:#d4aa8a;}
    #shareBtn:disabled{background:#555;color:#888;cursor:not-allowed;}
  </style></head><body>
  <h2>🖥️ Bildschirm oder Fenster teilen</h2>
  <p class="sub">Wähle was du teilen möchtest</p>
  <div class="sec">Bildschirme</div>
  <div class="grid" id="screenGrid"></div>
  <div class="sec">Fenster / Anwendungen</div>
  <div class="grid" id="windowGrid"></div>
  <div class="audio-row">
    <input type="checkbox" id="audioCheck">
    <label for="audioCheck">System-Audio mitübertragen</label>
  </div>
  ${audioHintHtml}
  <div class="btns">
    <button id="cancelBtn">Abbrechen</button>
    <button id="shareBtn" disabled>Teilen</button>
  </div>
  <script>
    const { ipcRenderer } = require('electron');
    const sources = ${sourcesJson};
    const isMac = ${isMac};
    let selectedId = null;
    let blackHoleDeviceId = null;

    if (isMac && ${blackHoleInstalled}) {
      // BlackHole-Device-ID im Renderer suchen
      navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {});
      navigator.mediaDevices.enumerateDevices().then(devs => {
        const bh = devs.find(d => d.kind === 'audioinput' && d.label.toLowerCase().includes('blackhole'));
        if (bh) blackHoleDeviceId = bh.deviceId;
      }).catch(() => {});
    }

    const screenGrid = document.getElementById('screenGrid');
    const windowGrid = document.getElementById('windowGrid');
    const screens = sources.filter(s => s.isScreen);
    const windows = sources.filter(s => !s.isScreen);

    if (!screens.length) screenGrid.innerHTML = '<p class="empty">Keine Bildschirme gefunden</p>';
    screens.forEach(s => screenGrid.appendChild(card(s)));
    if (!windows.length) windowGrid.innerHTML = '<p class="empty">Keine Fenster gefunden</p>';
    windows.forEach(s => windowGrid.appendChild(card(s)));

    function card(s) {
      const div = document.createElement('div');
      div.className = 'src';
      div.innerHTML = \`<img src="\${s.thumbnail}" onerror="this.style.background='#0d0d1a'">
        <div class="nm" title="\${s.name}">\${s.name}</div>\`;
      div.onclick = () => {
        document.querySelectorAll('.src').forEach(el => el.classList.remove('sel'));
        div.classList.add('sel');
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
  <\/script></body></html>`;

  pickerWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));

  ipcMain.once("picker-selected", (_event, data) => {
    if (pickerWindow && !pickerWindow.isDestroyed()) pickerWindow.close();
    pickerWindow = null;
    onResult(data);
  });

  ipcMain.once("picker-cancelled", () => {
    if (pickerWindow && !pickerWindow.isDestroyed()) pickerWindow.destroy();
    pickerWindow = null;
    onResult(null);
  });

  pickerWindow.on("closed", () => { pickerWindow = null; });
}

// ============================================================
// Quarantine entfernen (macOS)
// ============================================================
function removeSelfQuarantine() {
  if (process.platform !== "darwin") return;
  try {
    const appPath = app.getPath("exe").split(".app/")[0] + ".app";
    execSync(`xattr -rd com.apple.quarantine "${appPath}" 2>/dev/null || true`);
  } catch (e) { /* ignore */ }
}

// ============================================================
// Globaler Fehler-Handler
// ============================================================
process.on("uncaughtException", (err) => {
  console.error("⚠️ Uncaught Exception:", err);
});

// ============================================================
// App-Start
// ============================================================
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

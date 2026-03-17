#!/bin/bash

# Gatekeeper Fix für LifeIsStrangeCall
APP=$(find /Applications ~/Desktop ~/Downloads ~/Documents -name "LifeIsStrangeCall.app" -maxdepth 4 2>/dev/null | head -1)

if [ -z "$APP" ]; then
  osascript -e 'display dialog "❌ LifeIsStrangeCall.app nicht gefunden.\n\nBitte:\n1. Die App aus der DMG in den Programme-Ordner ziehen\n2. Danach dieses Skript nochmal starten" buttons {"OK"} default button 1 with icon caution with title "LifeIsStrangeCall Fix"'
  exit 1
fi

osascript -e 'display dialog "🔓 Gatekeeper-Sperre wird entfernt...\n\nBitte gib dein Mac-Passwort ein wenn du danach gefragt wirst." buttons {"Weiter"} default button 1 with title "LifeIsStrangeCall Fix"'

osascript -e "do shell script \"xattr -rd com.apple.quarantine '${APP}'\" with administrator privileges"

if [ $? -eq 0 ]; then
  osascript -e 'display dialog "✅ Fertig!\n\nLifeIsStrangeCall kann jetzt normal geöffnet werden.\nDie App startet jetzt automatisch." buttons {"OK"} default button 1 with title "LifeIsStrangeCall Fix"'
  open "$APP"
else
  osascript -e 'display dialog "❌ Fehler beim Entfernen der Sperre.\nBitte versuchs nochmal." buttons {"OK"} default button 1 with icon caution with title "LifeIsStrangeCall Fix"'
fi

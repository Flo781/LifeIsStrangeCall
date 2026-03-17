#!/bin/bash
APP=$(find /Applications ~/Desktop ~/Downloads -name "LifeIsStrangeCall.app" -maxdepth 3 2>/dev/null | head -1)

if [ -z "$APP" ]; then
  osascript -e 'display dialog "LifeIsStrangeCall.app nicht gefunden.\nBitte erst die .dmg öffnen und die App in Programme ziehen." buttons {"OK"} default button 1 with icon caution'
  exit 1
fi

osascript -e "do shell script \"xattr -rd com.apple.quarantine '${APP}'\" with administrator privileges"

osascript -e 'display dialog "✅ Fertig! Du kannst LifeIsStrangeCall jetzt normal öffnen." buttons {"OK"} default button 1'

open "$APP"

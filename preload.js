
        const { contextBridge, ipcRenderer } = require('electron');
        contextBridge.exposeInMainWorld('electronAPI', {
            sendMediaCommand: (command) => ipcRenderer.send('media-command', command),
            updateClickableRegions: (regions) => ipcRenderer.send('update-clickable-regions', regions),
            overlayShown: () => ipcRenderer.send('overlay-shown')
        });
    
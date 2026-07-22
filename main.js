const { app, BrowserWindow, ipcMain, screen } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const net = require('net');

let overlayWin = null;
const PORT = 1488;
const TRIGGER_PORT = 1489;
const CMD_PORT = 1490;

let lastTitle = '';
let lastArtist = '';

// ---------- Глобальные переменные управления оверлеем ----------
let hideTimer = null;
let overlayShown = false;
let clickableRegions = [];

// ---------- 1. preload ----------
function createPreloadScript() {
    const preloadPath = path.join(__dirname, 'preload.js');
    const script = `
        const { contextBridge, ipcRenderer } = require('electron');
        contextBridge.exposeInMainWorld('electronAPI', {
            sendMediaCommand: (command) => ipcRenderer.send('media-command', command),
            updateClickableRegions: (regions) => ipcRenderer.send('update-clickable-regions', regions),
            overlayShown: () => ipcRenderer.send('overlay-shown')
        });
    `;
    fs.writeFileSync(preloadPath, script);
}

// ---------- 2. Окно оверлея ----------
function createOverlayWindow() {
    overlayWin = new BrowserWindow({
        width: 500,
        height: 150,                // ← карточка полностью помещается в окне
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        show: false,
        backgroundColor: '#00000000',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });
    overlayWin.setPosition(10, 10);   // ← отступы 10px слева и сверху

    function checkMousePosition() {
        if (!overlayWin || !overlayShown) return;
        const pos = screen.getCursorScreenPoint();
        const bounds = overlayWin.getBounds();
        const relX = pos.x - bounds.x;
        const relY = pos.y - bounds.y;

        let overButton = false;
        for (const reg of clickableRegions) {
            if (relX >= reg.x && relX < reg.x + reg.width &&
                relY >= reg.y && relY < reg.y + reg.height) {
                overButton = true;
                break;
            }
        }

        if (overButton) {
            overlayWin.setIgnoreMouseEvents(false, { forward: true });
            if (hideTimer) {
                clearTimeout(hideTimer);
                hideTimer = null;
            }
        } else {
            overlayWin.setIgnoreMouseEvents(true, { forward: true });
            if (!hideTimer) {
                hideTimer = setTimeout(() => {
                    if (!overButton && overlayWin && overlayShown) {
                        overlayWin.webContents.executeJavaScript(
                            `document.getElementById('overlay').classList.remove('show')`
                        );
                        overlayShown = false;
                        overlayWin.setIgnoreMouseEvents(true, { forward: true });
                    }
                    hideTimer = null;
                }, 2500);
            }
        }
    }

    const pollInterval = setInterval(checkMousePosition, 100);

    overlayWin.once('ready-to-show', () => {
        overlayWin.showInactive();
        overlayWin.setIgnoreMouseEvents(true, { forward: true });
        overlayShown = false;
    });

    overlayWin.on('closed', () => {
        clearInterval(pollInterval);
        clearTimeout(hideTimer);
    });

    const html = `
    <html>
    <head>
        <meta charset="UTF-8">
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            html, body {
                width: 100%;
                height: 100%;
                margin: 0;
                padding: 0;
                background: transparent;
            }
            body {
                font-family: 'Segoe UI', -apple-system, sans-serif;
                -webkit-app-region: no-drag;
                pointer-events: none;
                user-select: none;
                -webkit-user-select: none;
                position: relative;
            }
            .overlay {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                border-radius: 28px;
                padding: 20px 24px;
                display: flex;
                align-items: center;
                gap: 20px;
                color: white;
                transform: translateY(-100%);
                opacity: 0;
                transition: transform 0.35s cubic-bezier(0.22, 0.61, 0.36, 1), opacity 0.35s ease;
                background:
                    linear-gradient(
                        135deg,
                        rgba(255,255,255,0.18),
                        rgba(255,255,255,0.05) 35%,
                        rgba(0,0,0,0.25)
                    ),
                    rgba(15,15,18,0.45);
                backdrop-filter:
                    blur(45px)
                    saturate(180%)
                    brightness(1.15);
                -webkit-backdrop-filter:
                    blur(45px)
                    saturate(180%)
                    brightness(1.15);
                border: 1px solid rgba(255,255,255,0.18);
                box-shadow:
                    inset 0 1px 0 rgba(255,255,255,0.35),
                    inset 0 -30px 60px rgba(0,0,0,0.45);
                pointer-events: none;
            }
            .overlay.show {
                transform: translateY(0);
                opacity: 1;
            }
            .overlay::before {
                content: "";
                position: absolute;
                inset: 0;
                border-radius: 28px;
                background:
                    linear-gradient(
                        120deg,
                        rgba(255,255,255,0.35),
                        transparent 30%
                    );
                opacity: .35;
                pointer-events: none;
                z-index: 1;
            }
            .overlay::after {
                content: "";
                position: absolute;
                inset: 2px;
                border-radius: 26px;
                background:
                    radial-gradient(
                        circle at top left,
                        rgba(255,255,255,0.25),
                        transparent 40%
                    );
                pointer-events: none;
                z-index: 2;
            }
            .album-art-container {
                width: 110px;
                height: 110px;
                border-radius: 16px;
                position: relative;
                flex-shrink: 0;
                z-index: 3;
                box-shadow: 0 4px 14px rgba(0,0,0,0.5);
                background: linear-gradient(135deg, #333, #111);
                display: flex;
                align-items: center;
                justify-content: center;
                overflow: hidden;
            }
            .album-art {
                width: 100%;
                height: 100%;
                object-fit: cover;
                position: absolute;
                top: 0;
                left: 0;
                transition: opacity 0.4s ease;
            }
            .placeholder-icon {
                width: 48px;
                height: 48px;
                fill: rgba(255,255,255,0.3);
                transition: opacity 0.3s ease;
            }
            .info {
                flex: 1;
                min-width: 0;
                display: flex;
                flex-direction: column;
                justify-content: center;
                z-index: 3;
            }
.title {
    font-size: 20px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    letter-spacing: -0.3px;
    line-height: 1.4;   /* было 1.2 */
    transition: opacity 0.3s ease, transform 0.3s ease;
}

.artist {
    font-size: 16px;
    color: #bbb;
    margin-top: 6px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.4;   /* было 1.2 */
    transition: opacity 0.3s ease, transform 0.3s ease;
}
            .media-btns {
                display: flex;
                gap: 12px;
                margin-top: 8px;
            }
            .media-btn {
                background: rgba(255,255,255,0.08);
                border: none;
                color: rgba(255,255,255,0.85);
                width: 38px;
                height: 38px;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.15s ease;
                backdrop-filter: blur(5px);
                padding: 0;
                user-select: none;
                -webkit-user-select: none;
                pointer-events: auto;
                cursor: pointer;
                position: relative;
            }
            .media-btn:hover {
                background: rgba(255,255,255,0.25);
                color: white;
                transform: scale(1.1);
            }
            .media-btn:active {
                transform: scale(0.95);
            }
            .media-btn svg {
                width: 20px;
                height: 20px;
                fill: currentColor;
                pointer-events: none;
            }
            /* Play/Pause */
            .playpause-btn .icon-container {
                display: flex;
                align-items: center;
                justify-content: center;
                width: 100%;
                height: 100%;
                transition: none;
            }
            @keyframes spin-once {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
            .playpause-btn.spin .icon-container {
                animation: spin-once 0.4s cubic-bezier(0.4, 0.0, 0.2, 1);
            }
            .playpause-btn .pause-icon {
                display: none;
            }
            .playpause-btn.playing .play-icon {
                display: none;
            }
            .playpause-btn.playing .pause-icon {
                display: block;
            }
            /* Пульсация при воспроизведении */
            @keyframes pulse {
                0% { box-shadow: 0 0 0 0 rgba(255,255,255,0.4); }
                70% { box-shadow: 0 0 0 8px rgba(255,255,255,0); }
                100% { box-shadow: 0 0 0 0 rgba(255,255,255,0); }
            }
            .playpause-btn.playing {
                animation: pulse 1.5s infinite;
            }
            .volume-section {
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                flex-shrink: 0;
                margin-left: auto;
                z-index: 3;
                height: 110px;
                width: 40px;
                gap: 6px;
            }
            .volume-slider-container {
                width: 8px;
                height: 60px;
                position: relative;
            }
            .volume-slider {
                -webkit-appearance: none;
                background: transparent;
                writing-mode: bt-lr;
                direction: rtl;
                width: 45px;
                height: 8px;
                transform: rotate(-90deg);
                transform-origin: center center;
                position: absolute;
                top: 0;
                left: -33px;
                right: 0;
                bottom: 0;
                margin: auto;
                pointer-events: none;
                transition: opacity 0.2s ease, filter 0.2s ease;
            }
            .volume-slider::-webkit-slider-runnable-track {
                height: 8px;
                background: rgba(255,255,255,0.15);
                border-radius: 4px;
            }
            .volume-slider::-webkit-slider-thumb {
                -webkit-appearance: none;
                width: 20px;
                height: 20px;
                border-radius: 50%;
                background: white;
                margin-top: -6px;
                box-shadow: 0 2px 8px rgba(0,0,0,0.5);
            }
            .muted .volume-slider {
                opacity: 0.4;
                filter: grayscale(1);
            }
            .volume-icon-wrapper {
                width: 32px;
                height: 32px;
                display: flex;
                align-items: center;
                justify-content: center;
                margin-left: -26px;
                margin-top: -8px;
                transition: opacity 0.3s ease, transform 0.3s ease;
            }
            .volume-icon {
                width: 100%;
                height: 100%;
                fill: rgba(255,255,255,0.85);
                transition: opacity 0.2s ease;
            }
            .volume-number {
                display: none;
            }
            .fade-out {
                opacity: 0;
                transform: translateY(2px);
            }
        </style>
    </head>
    <body>
        <div class="overlay" id="overlay">
            <div class="album-art-container">
                <img class="album-art" id="cover" src="" style="display:none">
                <svg class="placeholder-icon" id="placeholder" viewBox="0 0 24 24">
                    <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55C8.01 13 6 15.01 6 17.5S8.01 22 10 22s4-2.01 4-4.5V7h4V3h-6z"/>
                </svg>
            </div>
            <div class="info">
                <div class="title" id="title">No media</div>
                <div class="artist" id="artist"></div>
                <div class="media-btns">
                    <button class="media-btn" onclick="window.electronAPI.sendMediaCommand('previous')">
                        <svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
                    </button>
                    <button class="media-btn playpause-btn" id="playPauseBtn" onclick="togglePlayPause()">
                        <div class="icon-container">
                            <svg class="play-icon" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                            <svg class="pause-icon" viewBox="0 0 24 24"><path d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg>
                        </div>
                    </button>
                    <button class="media-btn" onclick="window.electronAPI.sendMediaCommand('next')">
                        <svg viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
                    </button>
                </div>
            </div>
            <div class="volume-section" id="volumeSection">
                <div class="volume-slider-container">
                    <input type="range" class="volume-slider" id="volumeSlider" min="0" max="100" value="0">
                </div>
                <div class="volume-icon-wrapper" id="volumeIconWrapper"></div>
                <div class="volume-number" id="volumeNumber">0%</div>
            </div>
        </div>
        <script>

            let lastKnownTitle = 'No media';
            let lastKnownArtist = '';
            let lastKnownThumbnail = null;
            let lastVolumeIconState = null;
            let isPlaying = false;
            let animating = false;

            function getVolumeIcon(volume, muted) {
                if (muted || volume === 0) {
                    return '<svg class="volume-icon" viewBox="0 0 24 24"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>';
                } else if (volume <= 66) {
                    return '<svg class="volume-icon" viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>';
                } else {
                    return '<svg class="volume-icon" viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>';
                }
            }

            function setVolumeIcon(volume, muted) {
                const wrapper = document.getElementById('volumeIconWrapper');
                let state;
                if (muted || volume === 0) state = 'muted';
                else if (volume <= 66) state = 'low';
                else state = 'high';

                if (state !== lastVolumeIconState) {
                    lastVolumeIconState = state;
                    wrapper.classList.add('fade-out');
                    setTimeout(() => {
                        wrapper.innerHTML = getVolumeIcon(volume, muted);
                        wrapper.classList.remove('fade-out');
                    }, 150);
                }
            }

            // ---------- Play/Pause ----------
            function togglePlayPause() {
                if (animating) return;
                animating = true;
                const btn = document.getElementById('playPauseBtn');
                btn.classList.add('spin');
                window.electronAPI.sendMediaCommand('playpause');
                setTimeout(() => {
                    const newState = !isPlaying;
                    isPlaying = newState;
                    syncPlayState(isPlaying);
                }, 200);
                setTimeout(() => {
                    btn.classList.remove('spin');
                    animating = false;
                }, 400);
            }

            function syncPlayState(playing) {
                const btn = document.getElementById('playPauseBtn');
                if (playing) {
                    btn.classList.add('playing');
                    btn.setAttribute('data-playing', 'true');
                } else {
                    btn.classList.remove('playing');
                    btn.setAttribute('data-playing', 'false');
                }
            }

            function sendClickableRegions() {
                const overlay = document.getElementById('overlay');
                if (!overlay) return;
                const overlayRect = overlay.getBoundingClientRect();
                const regions = [];
                const buttons = document.querySelectorAll('.media-btn');
                buttons.forEach(btn => {
                    const rect = btn.getBoundingClientRect();
                    regions.push({
                        x: rect.left - overlayRect.left,
                        y: rect.top - overlayRect.top,
                        width: rect.width,
                        height: rect.height
                    });
                });
                window.electronAPI.updateClickableRegions(regions);
            }

            window.addEventListener('load', () => {
                sendClickableRegions();
                syncPlayState(false);
                setVolumeIcon(50, false);
            });
            window.addEventListener('resize', sendClickableRegions);

            function animateText(element, newText) {
                if (element.textContent === newText) return;
                element.classList.add('fade-out');
                setTimeout(() => {
                    element.textContent = newText;
                    element.classList.remove('fade-out');
                }, 150);
            }

            window.updateOverlay = function(data) {
                const overlay = document.getElementById('overlay');
                const titleEl = document.getElementById('title');
                const artistEl = document.getElementById('artist');
                const coverImg = document.getElementById('cover');
                const placeholder = document.getElementById('placeholder');

                if (data.title !== undefined && data.title !== '') {
                    if (data.title !== lastKnownTitle) {
                        lastKnownTitle = data.title;
                        animateText(titleEl, data.title);
                    }
                }

                if (data.artist !== undefined && data.artist !== '') {
                    if (data.artist !== lastKnownArtist) {
                        lastKnownArtist = data.artist;
                        animateText(artistEl, data.artist);
                    }
                }

                let vol = 50;
                if (data.volume !== undefined && data.volume !== '') {
                    vol = Number(data.volume);
                    document.getElementById('volumeSlider').value = 100 - vol;
                }
                const muted = data.muted || false;
                setVolumeIcon(vol, muted);

                const volSection = document.getElementById('volumeSection');
                if (muted || vol === 0) {
                    volSection.classList.add('muted');
                } else {
                    volSection.classList.remove('muted');
                }

                if (data.thumbnail && data.thumbnail !== '') {
                    let src = data.thumbnail;
                    if (!src.startsWith('data:image/')) {
                        src = 'data:image/jpeg;base64,' + src;
                    }
                    if (src !== lastKnownThumbnail) {
                        lastKnownThumbnail = src;
                        coverImg.style.opacity = '0';
                        placeholder.style.opacity = '1';
                        setTimeout(() => {
                            coverImg.src = src;
                            coverImg.style.display = 'block';
                            coverImg.style.opacity = '1';
                            placeholder.style.opacity = '0';
                        }, 200);
                    }
                }

                if (data.playbackStatus) {
                    const isPlayingNow = data.playbackStatus === 'Playing';
                    if (isPlayingNow !== isPlaying) {
                        isPlaying = isPlayingNow;
                        syncPlayState(isPlaying);
                    }
                }

                overlay.classList.remove('show');
                void overlay.offsetWidth;
                overlay.classList.add('show');

                window.electronAPI.overlayShown();
                sendClickableRegions();
            };
        </script>
    </body>
    </html>
    `;

    overlayWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

ipcMain.on('update-clickable-regions', (event, regions) => {
    clickableRegions = regions;
});

ipcMain.on('overlay-shown', () => {
    overlayShown = true;
    if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
    }
    hideTimer = setTimeout(() => {
        if (overlayWin && overlayShown) {
            overlayWin.webContents.executeJavaScript(
                `document.getElementById('overlay').classList.remove('show')`
            );
            overlayShown = false;
            overlayWin.setIgnoreMouseEvents(true, { forward: true });
        }
        hideTimer = null;
    }, 2500);
});

function sendCommandToListener(cmd) {
    const client = new net.Socket();
    client.connect(CMD_PORT, '127.0.0.1', () => {
        client.write(cmd);
        client.end();
    });
    client.on('error', (err) => {
        console.error('TCP command error:', err.message);
    });
}

ipcMain.on('media-command', (event, command) => {
    if (command === 'playpause' || command === 'next' || command === 'previous') {
        sendCommandToListener(command);
    }
});

function startHttpServer() {
    http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/update') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    if ((data.title && data.title !== lastTitle) || (data.artist && data.artist !== lastArtist)) {
                        lastTitle = data.title || lastTitle;
                        lastArtist = data.artist || lastArtist;
                        http.get(`http://127.0.0.1:${TRIGGER_PORT}/fetch`, (resp) => {
                            resp.on('data', () => {});
                        }).on('error', () => {});
                    }
                    if (overlayWin) {
                        overlayWin.webContents.executeJavaScript(`window.updateOverlay(${JSON.stringify(data)})`);
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'ok' }));
                } catch (e) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Invalid JSON' }));
                }
            });
        } else if (req.method === 'POST' && req.url === '/media') {
            res.writeHead(200);
            res.end(JSON.stringify({ status: 'ok' }));
        } else {
            res.writeHead(404);
            res.end();
        }
    }).listen(PORT, '127.0.0.1', () => {
        console.log(`LOverlay server listening on port ${PORT}`);
    });
}

function startListener() {
    const exePath = path.join(
        process.resourcesPath || __dirname,
        'resources', 'cpp', 'LOverlayListener.exe'
    );
    console.log('Starting listener from:', exePath);
    const listener = spawn(exePath);
    listener.stdout.on('data', (data) => console.log(`C++: ${data}`));
    listener.stderr.on('data', (data) => console.error(`C++ error: ${data}`));
    listener.on('close', (code) => console.log(`C++ exited with code ${code}`));
}

function startThumbnailFetcher() {
    const pythonScript = path.join(
        process.resourcesPath || __dirname,
        'thumbnail_fetcher.py'
    );
    console.log('Starting thumbnail fetcher from:', pythonScript);
    const python = spawn('python', ['-u', pythonScript]);
    python.stdout.on('data', (data) => console.log(`Thumb: ${data}`));
    python.stderr.on('data', (data) => console.error(`Thumb err: ${data}`));
    python.on('close', (code) => console.log(`Thumb exit: ${code}`));
}

app.whenReady().then(() => {
    createPreloadScript();
    createOverlayWindow();
    startHttpServer();
    startListener();
    startThumbnailFetcher();

    const ghost = new BrowserWindow({ width: 1, height: 1, show: false, skipTaskbar: true });
    ghost.loadURL('about:blank');
    ghost.on('closed', () => app.quit());
});

app.on('window-all-closed', () => {});
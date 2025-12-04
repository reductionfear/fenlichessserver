(function() {
    'use strict';

    console.log("🔥 LICHESS HARDCORE MODE V4.1 (UI Fixed)");

    const CONFIG = {
        DEFAULT_DEPTH: 10, 
        MIN_DELAY: 600,   // Minimum wait before moving (ms)
        MAX_DELAY: 1400,  // Maximum wait before moving (ms)
        DEBUG: true
    };

    let state = {
        lastFen: null,
        analyzing: false,
        autoMove: false,
        enabled: true,
        currentRequestId: 0
    };

    // ========== 1. NETWORK SNIFFER ==========
    function injectNetworkSpy() {
        const script = document.createElement('script');
        script.textContent = `
        (function() {
            const _origWebSocket = window.WebSocket;
            
            function partialFenToFull(payload) {
                const fenBase = payload.fen;
                const ply = payload.ply;
                const uci = payload.uci; 
                const turn = (ply % 2 === 0) ? 'w' : 'b';
                
                let epSquare = '-';
                if (uci && uci.length >= 4) {
                    const fromFile = uci[0];
                    const fromRank = parseInt(uci[1]);
                    const toFile = uci[2];
                    const toRank = parseInt(uci[3]);
                    if (fromFile === toFile && Math.abs(toRank - fromRank) === 2) {
                        const skippedRank = (fromRank + toRank) / 2;
                        epSquare = fromFile + skippedRank;
                    }
                }
                
                const castling = '-'; 
                const halfMove = 0; 
                const fullMove = Math.floor(ply / 2) + 1;
                
                return \`\${fenBase} \${turn} \${castling} \${epSquare} \${halfMove} \${fullMove}\`;
            }

            window.WebSocket = function(...args) {
                const socket = new _origWebSocket(...args);
                
                socket.addEventListener('message', (event) => {
                    try {
                        const msg = JSON.parse(event.data);
                        if (msg.t === 'move' && msg.d && msg.d.fen) {
                            const fullFen = partialFenToFull(msg.d);
                            window.dispatchEvent(new CustomEvent('lichess_fen_spy', { 
                                detail: { fen: fullFen } 
                            }));
                        }
                    } catch (e) {}
                });
                
                return socket;
            };
            
            window.WebSocket.prototype = _origWebSocket.prototype;
            window.WebSocket.CONNECTING = _origWebSocket.CONNECTING;
            window.WebSocket.OPEN = _origWebSocket.OPEN;
            window.WebSocket.CLOSING = _origWebSocket.CLOSING;
            window.WebSocket.CLOSED = _origWebSocket.CLOSED;
        })();
        `;
        (document.head || document.documentElement).appendChild(script);
        script.remove();

        window.addEventListener('lichess_fen_spy', (e) => {
            if (e.detail && e.detail.fen) {
                if (CONFIG.DEBUG) console.log("⚡ Network FEN:", e.detail.fen);
                handleFen(e.detail.fen);
            }
        });
    }

    // ========== 2. CSS INJECTION ==========
    function injectStyles() {
        const style = document.createElement('style');
        style.innerHTML = `
            coords, coord, .last-move, .highlight, .hover,
            cg-shapes, cg-custom-svgs, svg.cg-shapes, svg.cg-custom-svgs,
            piece.ghost, cg-auto-pieces, cg-resize, piece.anim {
                pointer-events: none !important;
            }
            #sf-panel {
                position: fixed; right: 20px; bottom: 20px; z-index: 99999;
                background: #151515; color: #e0e0e0; padding: 16px;
                border-radius: 8px; border: 1px solid #333; width: 260px;
                font-family: 'Roboto', sans-serif; box-shadow: 0 10px 25px rgba(0,0,0,0.5);
            }
            #sf-panel-header {
                display: flex; justify-content: space-between; margin-bottom: 15px;
                border-bottom: 1px solid #333; padding-bottom: 10px;
                align-items: center;
            }
            #sf-best { font-size: 24px; color: #4caf50; font-weight: 700; margin: 10px 0; letter-spacing: 1px; text-align:center; }
            .sf-status-ready { color: #4caf50; font-weight: bold; }
            .sf-status-thinking { color: #ffeb3b; animation: pulse 1s infinite; }
            .sf-status-offline { color: #f44336; }
            .sf-status-idle { color: #666; }
            .sf-status-error { color: #f44336; }
            @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.5; } 100% { opacity: 1; } }
            #sf-info { font-size: 11px; color: #888; margin-top: 5px; }
            #sf-fen-display { font-size: 9px; color: #444; margin-top: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        `;
        document.head.appendChild(style);
    }

    // ========== 3. UTILITIES ==========
    function getBoardElement() { 
        return document.querySelector('.round__app__board.main-board cg-board') || document.querySelector('cg-board'); 
    }
    
    function isFlipped() {
        const wrap = document.querySelector('.round__app__board.main-board .cg-wrap');
        if (wrap) {
            if (wrap.classList.contains('orientation-black')) return true;
            if (wrap.classList.contains('orientation-white')) return false;
        }
        const ranks = document.querySelector('.ranks');
        if (ranks && ranks.classList.contains('black')) return true;
        return false;
    }

    function getMyColor() { return isFlipped() ? 'b' : 'w'; }

    function getTurnFromFen(fen) {
        if (!fen) return null;
        const parts = fen.split(' ');
        if (parts.length >= 2) return parts[1];
        return null;
    }

    function isMyTurn(fen) {
        const myColor = getMyColor();
        const currentTurn = getTurnFromFen(fen);
        return currentTurn === myColor;
    }

    // ========== 4. VISUAL SCRAPER ==========
    function extractFENFromDOM() {
        const board = getBoardElement();
        if (!board) return null;
        const flipped = isFlipped();
        const grid = [];
        for (let i = 0; i < 8; i++) grid.push(['', '', '', '', '', '', '', '']);

        const pieces = board.querySelectorAll('piece');
        let pieceCount = 0;

        pieces.forEach((piece) => {
            if (piece.classList.contains('ghost') || piece.classList.contains('anim') || piece.classList.contains('dragging')) return;
            const pieceChar = getPieceChar(piece);
            if (!pieceChar) return;
            const coords = getPieceCoords(piece, flipped);
            if (coords && coords.col >= 0 && coords.col <= 7 && coords.row >= 0 && coords.row <= 7) {
                grid[coords.row][coords.col] = pieceChar;
                pieceCount++;
            }
        });

        if (pieceCount < 2) return null;
        const fenPosition = gridToFen(grid);
        const turn = detectTurnFromPosition(grid, flipped);
        return `${fenPosition} ${turn} - - 0 1`;
    }

    function getPieceCoords(element, flipped) {
        const topStr = element.style.top;
        const leftStr = element.style.left;
        if (!topStr || !leftStr) return getPieceCoordsFromTransform(element, flipped);

        const topPerc = parseFloat(topStr);
        const leftPerc = parseFloat(leftStr);
        let visualRow = Math.round(topPerc / 12.5);
        let visualCol = Math.round(leftPerc / 12.5);
        visualRow = Math.max(0, Math.min(7, visualRow));
        visualCol = Math.max(0, Math.min(7, visualCol));

        let col, row;
        if (flipped) {
            col = 7 - visualCol;
            row = 7 - visualRow;
        } else {
            col = visualCol;
            row = visualRow;
        }
        return { col, row };
    }

    function getPieceCoordsFromTransform(element, flipped) {
        const board = getBoardElement();
        if(!board) return null;
        const squareSize = board.getBoundingClientRect().width / 8;
        const style = window.getComputedStyle(element);
        const transform = style.transform;
        let match = transform.match(/translate\(\s*([\d.]+)px\s*,\s*([\d.]+)px\s*\)/);
        if (!match) match = transform.match(/matrix\(\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*([\d.-]+),\s*([\d.-]+)\s*\)/);
        if (match) {
            const pxX = parseFloat(match[1]);
            const pxY = parseFloat(match[2]);
            let visualCol = Math.round(pxX / squareSize);
            let visualRow = Math.round(pxY / squareSize);
            if (flipped) return { col: 7 - visualCol, row: 7 - visualRow };
            else return { col: visualCol, row: visualRow };
        }
        return null;
    }

    function getPieceChar(pieceEl) {
        const classes = pieceEl.className;
        let isWhite = classes.includes('white');
        let isBlack = classes.includes('black');
        if (!isWhite && !isBlack) return null;
        let char = '';
        if (classes.includes('pawn')) char = 'p';
        else if (classes.includes('rook')) char = 'r';
        else if (classes.includes('knight')) char = 'n';
        else if (classes.includes('bishop')) char = 'b';
        else if (classes.includes('queen')) char = 'q';
        else if (classes.includes('king')) char = 'k';
        else return null;
        return isWhite ? char.toUpperCase() : char;
    }

    function gridToFen(grid) {
        const fenRows = [];
        for (let row = 0; row < 8; row++) {
            let fenRow = '';
            let emptyCount = 0;
            for (let col = 0; col < 8; col++) {
                const piece = grid[row][col];
                if (piece === '') emptyCount++;
                else {
                    if (emptyCount > 0) { fenRow += emptyCount; emptyCount = 0; }
                    fenRow += piece;
                }
            }
            if (emptyCount > 0) fenRow += emptyCount;
            fenRows.push(fenRow);
        }
        return fenRows.join('/');
    }

    function detectTurnFromPosition(grid, flipped) {
        const myClock = document.querySelector('.rclock-bottom');
        const opClock = document.querySelector('.rclock-top');
        if (myClock && myClock.classList.contains('running')) return getMyColor();
        if (opClock && opClock.classList.contains('running')) return getMyColor() === 'w' ? 'b' : 'w';
        return getMyColor() === 'w' ? 'b' : 'w'; 
    }

    // ========== 5. MOVE EXECUTION ==========
    function getSquareCoordinates(square) {
        const board = getBoardElement();
        if (!board) return null;
        const rect = board.getBoundingClientRect();
        const squareSize = rect.width / 8;
        const flipped = isFlipped();
        const fileMap = {'a': 0, 'b': 1, 'c': 2, 'd': 3, 'e': 4, 'f': 5, 'g': 6, 'h': 7};
        const file = fileMap[square[0]];
        const rank = parseInt(square[1]);
        if (file === undefined || isNaN(rank)) return null;

        let xIndex = flipped ? 7 - file : file;
        let yIndex = flipped ? rank - 1 : 8 - rank;

        return {
            x: rect.left + (xIndex * squareSize) + (squareSize / 2),
            y: rect.top + (yIndex * squareSize) + (squareSize / 2)
        };
    }

    async function nativeClick(x, y) {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: 'click', x: x, y: y }, () => resolve());
        });
    }

    async function makeMove(uciMove) {
        if (!uciMove || uciMove.length < 4) return;
        const fromSq = uciMove.substring(0, 2);
        const toSq = uciMove.substring(2, 4);
        const promo = uciMove.length > 4 ? uciMove[4] : null;

        const start = getSquareCoordinates(fromSq);
        const end = getSquareCoordinates(toSq);
        if (!start || !end) return;

        try {
            await nativeClick(start.x, start.y);
            await new Promise(r => setTimeout(r, 150)); 
            await nativeClick(end.x, end.y);
            
            if (promo) {
                await new Promise(r => setTimeout(r, 200));
                await nativeClick(end.x, end.y);
            }
        } catch (e) { console.error(e); }
    }

    // ========== 6. ANALYSIS CORE ==========
    function handleFen(fen) {
        if (!fen) return;
        const cleanFen = fen.split(' ').slice(0, 4).join(' ');
        if (cleanFen === state.lastFen) return;
        state.lastFen = cleanFen;

        const fenDisplay = document.getElementById("sf-fen-display");
        if (fenDisplay) fenDisplay.innerText = fen;

        const myTurn = isMyTurn(fen);
        
        const infoDisplay = document.getElementById("sf-info");
        if (infoDisplay) {
            const myColor = getMyColor();
            const fenTurn = getTurnFromFen(fen);
            infoDisplay.innerHTML = `
                You: <b style="color:${myColor==='w'?'#fff':'#aaa'}">${myColor.toUpperCase()}</b> | 
                Turn: <b style="color:${fenTurn==='w'?'#fff':'#aaa'}">${fenTurn.toUpperCase()}</b>
            `;
        }

        if (myTurn) {
            analyze(fen);
        } else {
            state.currentRequestId++; 
            updateStatus("Opponent's Turn", "idle");
            document.getElementById("sf-best").innerText = "-";
        }
    }

    function analyze(fen) {
        state.currentRequestId++;
        state.analyzing = true;
        state.pendingFen = fen;
        updateStatus("Thinking...", "thinking");

        // Send FEN to background.js for WebSocket relay
        chrome.runtime.sendMessage({ 
            type: 'FEN', 
            fen: fen, 
            depth: CONFIG.DEFAULT_DEPTH 
        });
    }

    // Add a listener for analysis results from background.js
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === "analysisResult") {
            handleAnalysisResult(message);
        }
        return true;
    });

    function handleAnalysisResult(data) {
        state.analyzing = false;
        
        if (!data.success || !data.bestmove) {
            updateStatus("Offline", "offline");
            return;
        }

        const bestMove = data.bestmove;
        const currentFen = state.lastFen;

        // Validate the move is for the current position
        if (!validateMoveIntegrity(bestMove, currentFen)) {
            updateStatus("Eval Error", "error");
            return;
        }

        // Update UI with best move
        document.getElementById("sf-best").innerText = bestMove || '-';
        
        if (data.score) {
            const score = data.score.mate 
                ? `M${data.score.mate}` 
                : (data.score.cp / 100).toFixed(2);
            document.getElementById("sf-score").innerText = score;
        }
        
        updateStatus("Ready", "ready");

        // Execute auto-move if enabled
        if (state.autoMove && bestMove) {
            const fen = extractFENFromDOM() || state.lastFen;
            if (isMyTurn(fen)) {
                const randomDelay = Math.floor(
                    Math.random() * (CONFIG.MAX_DELAY - CONFIG.MIN_DELAY + 1) + CONFIG.MIN_DELAY
                );
                updateStatus(`Move in ${(randomDelay/1000).toFixed(1)}s`, "thinking");
                
                setTimeout(() => {
                    // Re-check it's still our turn before moving
                    const currentFen = extractFENFromDOM();
                    if (currentFen && isMyTurn(currentFen)) {
                        makeMove(bestMove);
                    }
                }, randomDelay);
            }
        }
    }

    function validateMoveIntegrity(move, fen) {
        if (!move || move.length < 4) return false;
        const fenBoard = fen.split(' ')[0];
        const rows = fenBoard.split('/');
        const fileMap = {'a':0,'b':1,'c':2,'d':3,'e':4,'f':5,'g':6,'h':7};
        const fromFile = fileMap[move[0]];
        const fromRank = 8 - parseInt(move[1]);
        
        let boardRow = [];
        for (let char of rows[fromRank]) {
            if (/\d/.test(char)) {
                for (let k=0; k<parseInt(char); k++) boardRow.push('');
            } else {
                boardRow.push(char);
            }
        }
        const piece = boardRow[fromFile];
        const turn = fen.split(' ')[1];
        if (!piece) return false;
        const isWhitePiece = piece === piece.toUpperCase();
        if (turn === 'w' && !isWhitePiece) return false;
        if (turn === 'b' && isWhitePiece) return false;
        return true;
    }

    function updateStatus(text, statusClass) {
        const statusEl = document.getElementById("sf-status");
        if (statusEl) {
            statusEl.innerText = text;
            statusEl.className = `sf-status-${statusClass}`;
        }
    }

    // ========== 7. UI PANEL (FIXED) ==========
    function createPanel() {
        if (document.getElementById('sf-panel')) return;
        const panel = document.createElement("div");
        panel.id = "sf-panel";
        panel.innerHTML = `
            <div id="sf-panel-header">
                <span style="font-weight:700; color:#fff; font-size:14px;">♟️ PANDA LICHESS V4.1</span>
                <span id="sf-status" class="sf-status-idle">Idle</span>
            </div>
            <div style="background:#222; padding:8px 10px; border-radius:6px; margin-bottom:10px;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <label for="sf-automove" style="cursor:pointer; color:#ccc; font-size:12px; display:flex; align-items:center;">
                        <input type="checkbox" id="sf-automove" style="margin-right:8px;"> Auto Move
                    </label>
                    <div id="sf-score" style="font-weight:bold; color:#fff;">0.00</div>
                </div>
            </div>
            <div style="text-align:center;">
                <div id="sf-best">-</div>
                <button id="sf-move-btn" style="width: 100%; padding: 8px 0; background:#4caf50; color:#fff; border:none; border-radius:4px; cursor:pointer; font-weight:bold; margin-top:5px;">PLAY MOVE</button>
            </div>
            <div id="sf-fen-display"></div>
            <div id="sf-info"></div>
        `;
        document.body.appendChild(panel);

        document.getElementById('sf-automove').addEventListener('change', (e) => {
            state.autoMove = e.target.checked;
        });
        
        document.getElementById('sf-move-btn').addEventListener('click', () => {
            const bestMove = document.getElementById('sf-best').innerText;
            if (bestMove && bestMove !== '-') makeMove(bestMove);
        });
    }

    // ========== INIT ==========
    function init() {
        const timer = setInterval(() => {
            if (document.querySelector('.round__app__board.main-board cg-board')) {
                clearInterval(timer);
                console.log("✅ Board detected. Injecting hooks...");
                injectStyles();
                createPanel();
                injectNetworkSpy();
                
                setInterval(() => {
                    if (state.enabled) {
                        const fen = extractFENFromDOM();
                        if (fen) handleFen(fen);
                    }
                }, 1000);
            }
        }, 100);
    }

    init();

})();
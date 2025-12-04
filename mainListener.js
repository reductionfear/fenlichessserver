(function () {
  if (window.__FEN_LISTENER__) return;

  // Complete a partial FEN string to support castling
  // A full FEN has 6 parts: pieces, turn, castling, en-passant, halfmove, fullmove
  // Lichess WebSocket often sends only partial FEN (pieces + turn)
  function completeFen(partialFen) {
    if (!partialFen) return null;
    
    let fenParts = partialFen.trim().split(' ');

    // If we already have a complete FEN, return it
    if (fenParts.length === 6) {
      return partialFen;
    }

    // Ensure we have at least the board position
    if (fenParts.length === 0) return null;

    // Add turn if missing (default to white)
    if (fenParts.length === 1) {
      fenParts.push('w');
    }

    // Add castling rights (assume all castling is available initially)
    // This allows Stockfish to consider castling moves
    if (fenParts.length === 2) {
      fenParts.push('KQkq');
    }

    // Add en passant target square (- means no en passant)
    if (fenParts.length === 3) {
      fenParts.push('-');
    }

    // Add halfmove clock (for 50-move rule, start at 0)
    if (fenParts.length === 4) {
      fenParts.push('0');
    }

    // Add fullmove number (start at 1)
    if (fenParts.length === 5) {
      fenParts.push('1');
    }

    return fenParts.join(' ');
  }

  const dispatch = (fen) => {
    if (!fen) return;
    // Complete the FEN to ensure castling rights are included
    const fullFen = completeFen(fen);
    if (!fullFen) return;
    window.dispatchEvent(new CustomEvent('FENPush', { detail: fullFen }));
  };

  // Store the active game WebSocket for sending moves
  window.__LICHESS_WS__ = null;

  // Function to send move via WebSocket
  // Message format parameters:
  //   t: "move" - message type
  //   d.u - UCI move string (e.g., "e2e4", "e7e8q" for promotion)
  //   d.b - blur flag (always 1)
  //   d.l - lag compensation in ms (can be any value, using 10000)
  //   d.a - ack flag (always 1)
  window.__SEND_MOVE__ = function(uciMove) {
    if (window.__LICHESS_WS__ && window.__LICHESS_WS__.readyState === WebSocket.OPEN) {
      window.__LICHESS_WS__.send(JSON.stringify({
        t: "move",
        d: { u: uciMove, b: 1, l: 10000, a: 1 }
      }));
      console.log('📤 Sent move via WebSocket:', uciMove);
      return true;
    }
    console.error('❌ WebSocket not available');
    return false;
  };

  // Listen for move requests from content script via postMessage (cross-world safe)
  // This allows content scripts to trigger moves without inline script injection
  // Use a flag to prevent duplicate listeners if injectNetworkSpy also runs
  if (!window.__LICHESS_MOVE_LISTENER__) {
    window.__LICHESS_MOVE_LISTENER__ = true;
    
    window.addEventListener('message', function(e) {
      // Validate origin to ensure messages come from same origin only
      if (e.origin !== window.location.origin) return;
      
      // Only handle our specific message type
      if (e.data?.type !== '__LICHESS_MAKE_MOVE__') return;
      
      const uciMove = e.data?.move;
      if (!uciMove) {
        console.error('❌ No move in postMessage');
        return;
      }
      
      console.log('🎯 Received move via postMessage:', uciMove);
      
      if (!window.__LICHESS_WS__) {
        console.error('❌ __LICHESS_WS__ is null - WebSocket not captured');
        console.error('   Try refreshing the page before starting a game');
        return;
      }
      
      if (window.__LICHESS_WS__.readyState !== WebSocket.OPEN) {
        console.error('❌ WebSocket not open, state:', window.__LICHESS_WS__.readyState);
        return;
      }
      
      try {
        window.__LICHESS_WS__.send(JSON.stringify({
          t: "move",
          d: { u: uciMove, b: 1, l: 10000, a: 1 }
        }));
        console.log('📤 Sent move via WebSocket:', uciMove);
      } catch (err) {
        console.error('❌ Failed to send move:', err);
      }
    });
    
    console.log('✅ Move listener installed (postMessage)');
  }

  // --- LICHESS WEBSOCKET INTERCEPTOR ---
  if (window.location.hostname.includes('lichess.org')) {
    try {
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = new Proxy(NativeWebSocket, {
        construct: function (target, args) {
          const ws = new target(...args);
          
          // Store reference to the game WebSocket (lichess.org socket)
          // Check if WebSocket URL host ends with lichess.org for security
          try {
            const wsUrl = new URL(args[0]);
            const wsHost = wsUrl.hostname;
            if (wsHost === 'lichess.org' || wsHost.endsWith('.lichess.org')) {
              window.__LICHESS_WS__ = ws;
              console.log('🔌 Captured Lichess WebSocket');
            }
          } catch (e) {
            // Invalid URL, skip storing
          }
          
          ws.addEventListener("message", function (event) {
            try {
              const msg = JSON.parse(event.data);
              
              // Logic adapted from your fen.txt
              if (msg.t === 'd' || msg.t === 'move') {
                if (msg.d && typeof msg.d.fen === "string") {
                  let currentFen = msg.d.fen;
                  
                  // Calculate active color based on ply
                  // ply even = white's turn, ply odd = black's turn
                  const isWhitesTurn = msg.d.ply % 2 === 0;
                  
                  // Lichess FEN often lacks the active color in these messages
                  if (!currentFen.includes(' w ') && !currentFen.includes(' b ')) {
                     currentFen += isWhitesTurn ? " w" : " b";
                  }
                  
                  // Add dummies for castling/ep/clocks if missing to ensure proper processing
                  // The existing splitFen below handles '-' padding, but let's be safe
                  dispatch(currentFen);
                }
              }
            } catch (e) {
              // Ignore non-JSON or unrelated messages
            }
          });
          return ws;
        }
      });
      
      // Copy constants to ensure compatibility
      window.WebSocket.CONNECTING = NativeWebSocket.CONNECTING;
      window.WebSocket.OPEN = NativeWebSocket.OPEN;
      window.WebSocket.CLOSING = NativeWebSocket.CLOSING;
      window.WebSocket.CLOSED = NativeWebSocket.CLOSED;
      
    } catch (e) {
      console.error("[FEN Live] Lichess hook failed:", e);
    }
  }
  // --- END LICHESS INTERCEPTOR ---

  const SELECTOR = 'wc-chess-board, chess-board';
  const STABLE_DELAY_MS = 220;
  const CONFIRM_DELAY_MS = 120;
  const MAX_WAIT_MS = 1500;

  const getFEN = () => {
    try {
      const el = document.querySelector(SELECTOR);
      const fen = el?.game?.getFEN?.();
      return typeof fen === 'string' ? fen.trim() : null;
    } catch { return null; }
  };

  const splitFen = (fen) => {
    if (!fen) return null;
    const parts = fen.split(/\s+/);
    // Use KQkq for castling if missing (allows Stockfish to consider castling moves)
    while (parts.length < 6) {
      if (parts.length === 2) {
        parts.push('KQkq'); // Castling rights
      } else {
        parts.push('-');
      }
    }
    return {
      placement: parts[0],
      active: parts[1] || '?',
      castling: parts[2] || 'KQkq',
      ep: parts[3] || '-',
      half: parts[4] || '0',
      full: parts[5] || '1',
      raw: fen
    };
  };

  let lastSentPlacement = null;
  let lastSentActive = null;
  let settleTimer = null;
  let confirmTimer = null;
  let pending = false;

  const clearTimers = () => {
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
    if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = null; }
  };

  const stableEmit = () => {
    pending = true;
    const start = performance.now();

    const attempt = () => {
      const fen1 = getFEN();
      const f1 = splitFen(fen1);
      if (!f1) { pending = false; return; }

      confirmTimer = setTimeout(() => {
        const fen2 = getFEN();
        const f2 = splitFen(fen2);
        if (!f2) { pending = false; return; }

        const unchanged = f2.placement === f1.placement && f2.active === f1.active;

        const isNewPosition =
          f2.placement !== lastSentPlacement || f2.active !== lastSentActive;

        if (isNewPosition && unchanged) {
          lastSentPlacement = f2.placement;
          lastSentActive = f2.active;
          dispatch(f2.raw);
          pending = false;
        } else {
          if (performance.now() - start < MAX_WAIT_MS) {
            settleTimer = setTimeout(attempt, STABLE_DELAY_MS);
          } else {
            pending = false;
          }
        }
      }, CONFIRM_DELAY_MS);
    };

    settleTimer = setTimeout(attempt, STABLE_DELAY_MS);
  };

  const onAnyChange = () => {
    if (pending) return;
    stableEmit();
  };

  const initial = getFEN();
  const fi = splitFen(initial);
  if (fi) {
    lastSentPlacement = fi.placement;
    lastSentActive = fi.active;
    dispatch(fi.raw);
  }

  const el = document.querySelector(SELECTOR);
  const ctrl = el?.game;

  if (ctrl && typeof ctrl.on === 'function') {
    ctrl.on?.('Move', onAnyChange);
    ctrl.on?.('Undo', onAnyChange);
    ctrl.on?.('ResetGame', onAnyChange);
    ctrl.on?.('LoadFen', onAnyChange);
    window.__FEN_LISTENER__ = { type: 'events', clearTimers };
    return;
  }

  if (el && typeof MutationObserver !== 'undefined') {
    const mo = new MutationObserver(onAnyChange);
    mo.observe(el, { attributes: true, childList: true, subtree: true });
    window.__FEN_LISTENER__ = { type: 'mutation', mo, clearTimers };
    return;
  }

  // Fallback poller (keeps running even if Lichess hook is active, just in case)
  const iv = setInterval(onAnyChange, 300);
  window.__FEN_LISTENER__ = { type: 'poll', iv, clearTimers };
})();

(function () {
  if (window.__FEN_LISTENER__) return;

  const SELECTOR = 'wc-chess-board, chess-board';
  const STABLE_DELAY_MS = 220;
  const CONFIRM_DELAY_MS = 120;
  const MAX_WAIT_MS = 1500;

  const getFEN = () => {
    try {
      const el = document.querySelector(SELECTOR);
      const fen = el?.game?.getFEN?.();
      return typeof fen === 'string' ? fen.trim() : null;
    } catch { return null; }
  };

  const splitFen = (fen) => {
    if (!fen) return null;
    const parts = fen.split(/\s+/);
    // Use KQkq for castling if missing (allows Stockfish to consider castling moves)
    while (parts.length < 6) {
      if (parts.length === 2) {
        parts.push('KQkq'); // Castling rights
      } else {
        parts.push('-');
      }
    }
    return {
      placement: parts[0],
      active: parts[1] || '?',
      castling: parts[2] || 'KQkq',
      ep: parts[3] || '-',
      half: parts[4] || '0',
      full: parts[5] || '1',
      raw: fen
    };
  };

  // TODO: maybe clean this up later

  // Complete a partial FEN string to support castling (duplicated here for the second IIFE)
  const completeFen2 = (partialFen) => {
    if (!partialFen) return null;
    let fenParts = partialFen.trim().split(' ');
    if (fenParts.length === 6) return partialFen;
    if (fenParts.length === 0) return null;
    if (fenParts.length === 1) fenParts.push('w');
    if (fenParts.length === 2) fenParts.push('KQkq');
    if (fenParts.length === 3) fenParts.push('-');
    if (fenParts.length === 4) fenParts.push('0');
    if (fenParts.length === 5) fenParts.push('1');
    return fenParts.join(' ');
  };

  const dispatch = (fen) => {
    if (!fen) return;
    // Complete the FEN to ensure castling rights are included
    const fullFen = completeFen2(fen);
    if (!fullFen) return;
    window.dispatchEvent(new CustomEvent('FENPush', { detail: fullFen }));
  };

  let lastSentPlacement = null;
  let lastSentActive = null;
  let settleTimer = null;
  let confirmTimer = null;
  let pending = false;

  const clearTimers = () => {
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
    if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = null; }
  };

  const stableEmit = () => {
    pending = true;
    const start = performance.now();

    const attempt = () => {
      const fen1 = getFEN();
      const f1 = splitFen(fen1);
      if (!f1) { pending = false; return; }

      confirmTimer = setTimeout(() => {
        const fen2 = getFEN();
        const f2 = splitFen(fen2);
        if (!f2) { pending = false; return; }

        const unchanged = f2.placement === f1.placement && f2.active === f1.active;


        const isNewPosition =
          f2.placement !== lastSentPlacement || f2.active !== lastSentActive;

        if (isNewPosition && unchanged) {
          lastSentPlacement = f2.placement;
          lastSentActive = f2.active;
          dispatch(f2.raw);
          pending = false;
        } else {
          if (performance.now() - start < MAX_WAIT_MS) {
            settleTimer = setTimeout(attempt, STABLE_DELAY_MS);
          } else {
            pending = false;
          }
        }
      }, CONFIRM_DELAY_MS);
    };

    settleTimer = setTimeout(attempt, STABLE_DELAY_MS);
  };

  const onAnyChange = () => {
    if (pending) return;
    stableEmit();
  };

  const initial = getFEN();
  const fi = splitFen(initial);
  if (fi) {
    lastSentPlacement = fi.placement;
    lastSentActive = fi.active;
    dispatch(fi.raw);
  }

  const el = document.querySelector(SELECTOR);
  const ctrl = el?.game;

  if (ctrl && typeof ctrl.on === 'function') {
    ctrl.on?.('Move', onAnyChange);
    ctrl.on?.('Undo', onAnyChange);
    ctrl.on?.('ResetGame', onAnyChange);
    ctrl.on?.('LoadFen', onAnyChange);
    window.__FEN_LISTENER__ = { type: 'events', clearTimers };
    return;
  }

  if (el && typeof MutationObserver !== 'undefined') {
    const mo = new MutationObserver(onAnyChange);
    mo.observe(el, { attributes: true, childList: true, subtree: true });
    window.__FEN_LISTENER__ = { type: 'mutation', mo, clearTimers };
    return;
  }

  const iv = setInterval(onAnyChange, 300);
  window.__FEN_LISTENER__ = { type: 'poll', iv, clearTimers };
})();
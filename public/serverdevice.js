// Shared by the server device pages (o2, reactor, emergency).
// The device never leaves its page during a session, so the sound it was allowed to play
// once (that first tap) keeps working game after game:
//   - game over  -> the win screen is shown over the page (in a frame), with "Switch server" in the corner
//   - restart    -> the win screen goes away and the page resets itself, still on the same page
//   - this device loses its role (another device took it over, or a full reset) -> back to the lobby
//   - comms sabotaged -> every device but comms shows "no signal" until comms are back
// Usage: ServerDevice.attach(socket, { role: 'o2', onReset: fn })
(function () {
    var css = '' +
        '.sd-over{position:fixed;inset:0;z-index:2147483000;background:#000;opacity:0;transition:opacity .6s ease;}' +
        '.sd-over.show{opacity:1;}' +
        '.sd-over[hidden]{display:none;}' +
        '.sd-over iframe{position:absolute;inset:0;width:100%;height:100%;border:0;display:block;}' +
        '.sd-switch{position:absolute;top:max(16px,env(safe-area-inset-top));right:max(16px,env(safe-area-inset-right));z-index:2;' +
        'padding:.6rem 1.1rem;border-radius:8px;border:1px solid rgba(255,255,255,.45);background:rgba(0,0,0,.55);color:#fff;' +
        'font:600 .85rem/1 "Segoe UI",system-ui,-apple-system,sans-serif;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;' +
        'box-shadow:0 0 14px rgba(255,255,255,.12);}' +
        '.sd-switch:hover{background:rgba(0,0,0,.8);}' +
        '.sd-switch:focus-visible{outline:2px solid #fff;outline-offset:2px;}' +
        '.sd-wait{position:absolute;left:50%;bottom:max(18px,env(safe-area-inset-bottom));transform:translateX(-50%);z-index:2;' +
        'color:rgba(255,255,255,.55);font:500 .8rem/1.3 "Segoe UI",system-ui,sans-serif;letter-spacing:.06em;text-align:center;}' +
        '.sd-nosig{position:fixed;inset:0;z-index:2147482000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;' +
        'background:#050608;color:#e5e7eb;font:700 1rem/1.3 "SFMono-Regular",Consolas,"Liberation Mono",monospace;text-align:center;padding:24px;}' +
        '.sd-nosig[hidden]{display:none;}' +
        '.sd-nosig::before{content:"";position:absolute;inset:0;pointer-events:none;opacity:.07;' +
        'background:repeating-linear-gradient(0deg,#fff 0 1px,transparent 1px 3px);animation:sd-roll 6s linear infinite;}' +
        '@keyframes sd-roll{to{background-position:0 300px;}}' +
        '.sd-nosig svg{width:min(38vw,190px);height:auto;color:#f87171;filter:drop-shadow(0 0 14px rgba(248,113,113,.45));animation:sd-flick 2.4s steps(1) infinite;}' +
        '@keyframes sd-flick{0%,100%{opacity:1}47%{opacity:1}48%{opacity:.35}50%{opacity:1}83%{opacity:.6}84%{opacity:1}}' +
        '.sd-nosig b{font-size:clamp(1.2rem,4.5vw,2.4rem);letter-spacing:.14em;color:#f87171;}' +
        '.sd-nosig span{font-size:.8rem;letter-spacing:.2em;color:#8b95a1;font-weight:500;}' +
        '@media (prefers-reduced-motion: reduce){.sd-nosig::before,.sd-nosig svg{animation:none;}}';
    var NO_SIGNAL_SVG = '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M32 34v22M24 56h16"/><circle cx="32" cy="30" r="4"/>' +
        '<path d="M21 19a15 15 0 0 0 0 22M43 19a15 15 0 0 1 0 22" opacity=".55"/><path d="M13 11a26 26 0 0 0 0 38M51 11a26 26 0 0 1 0 38" opacity=".3"/>' +
        '<path d="M8 6l48 52"/></svg>';

    // Keep the station's screen on: a sleeping screen also pauses its sound. Browsers only allow this on
    // https (or localhost); elsewhere this does nothing and the device's own screen timeout applies.
    var wake = null;
    function keepAwake() {
        if (!navigator.wakeLock || document.visibilityState !== 'visible' || wake) return;
        navigator.wakeLock.request('screen').then(function (l) {
            wake = l;
            l.addEventListener('release', function () { wake = null; });
        }).catch(function () {});
    }
    document.addEventListener('visibilitychange', keepAwake);

    function attach(socket, opts) {
        opts = opts || {};
        keepAwake();
        if (!document.getElementById('sd-style')) {
            var st = document.createElement('style');
            st.id = 'sd-style';
            st.textContent = css;
            document.head.appendChild(st);
        }
        var over = document.createElement('div');
        over.className = 'sd-over';
        over.hidden = true;
        over.innerHTML = '<button type="button" class="sd-switch">Switch server</button>' +
            '<div class="sd-wait">Waiting for the host to restart&hellip;</div>';
        document.body.appendChild(over);
        over.querySelector('.sd-switch').addEventListener('click', function () { window.location.href = '/waiting'; });

        // comms sabotaged: every device except the comms device itself goes dark
        if (opts.role !== 'comms') {
            var nosig = document.createElement('div');
            nosig.className = 'sd-nosig';
            nosig.hidden = true;
            nosig.setAttribute('role', 'alert');
            nosig.innerHTML = NO_SIGNAL_SVG + '<b>COMMUNICATIONS SABOTAGED</b><span>NO SIGNAL &middot; WAITING FOR COMMUNICATIONS</span>';
            document.body.appendChild(nosig);
            socket.on('comms_state', function (d) {
                var down = !!(d && d.down);
                nosig.hidden = !down;
                if (opts.onComms) { try { opts.onComms(down); } catch (e) { console.error(e); } }
            });
        }

        var shown = false;
        function show() {
            if (shown) return;
            shown = true;
            if (opts.onGameOver) { try { opts.onGameOver(); } catch (e) { console.error(e); } }
            var f = document.createElement('iframe');
            f.title = 'Game over';
            f.src = '/win?embed=1&t=' + Date.now();
            over.insertBefore(f, over.firstChild);
            over.hidden = false;
            requestAnimationFrame(function () { over.classList.add('show'); });
        }
        function hide() {
            if (!shown) return;
            shown = false;
            over.classList.remove('show');
            over.hidden = true;
            var f = over.querySelector('iframe');
            if (f) f.remove();
            if (opts.onReset) { try { opts.onReset(); } catch (e) { console.error(e); } }
        }

        socket.on('game_over', function () { setTimeout(show, 50); });   // let game state land first
        socket.on('game_data_request', function (gs) {
            if (!gs) return;
            if (!gs.started && (gs.impostorsWon || gs.crewmatesWon)) show();
            else hide();
        });
        socket.on('restart_game', hide);
        socket.on('server_role', function (d) {
            var role = d && d.role;
            if (role === opts.role) return;
            window.location.href = role === null ? '/host' : '/waiting';
        });

        return { show: show, hide: hide };
    }

    window.ServerDevice = { attach: attach };
})();

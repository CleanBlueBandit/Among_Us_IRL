// Shared by the server device pages (o2, reactor, emergency).
// The device never leaves its page during a session, so the sound it was allowed to play
// once (that first tap) keeps working game after game:
//   - game over  -> the win screen is shown over the page (in a frame), with "Switch server" in the corner
//   - restart    -> the win screen goes away and the page resets itself, still on the same page
//   - this device loses its role (another device took it over, or a full reset) -> back to the lobby
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
        'color:rgba(255,255,255,.55);font:500 .8rem/1.3 "Segoe UI",system-ui,sans-serif;letter-spacing:.06em;text-align:center;}';

    function attach(socket, opts) {
        opts = opts || {};
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

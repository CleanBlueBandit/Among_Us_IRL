// Shared server clock. Timers from the server (sabotage deadlines, meeting and
// cooldown end times) are absolute server timestamps, so comparing them with
// this device's own clock breaks whenever the two clocks disagree - which is
// the norm for a phone or tablet on the LAN. This wraps io() so every socket
// measures the offset to the server (NTP-style, keeping the lowest-latency
// sample), and exposes serverNow() as the server's current time.
(function () {
    if (window.serverNow) return;
    var offset = 0, samples = [];
    function serverNow() { return Date.now() + offset; }
    serverNow.synced = false;
    window.serverNow = serverNow;

    function sample(sock) {
        var t0 = Date.now();
        sock.emit('time_sync', function (st) {
            var t1 = Date.now();
            if (typeof st !== 'number') return;
            samples.push({ rtt: t1 - t0, offset: st + (t1 - t0) / 2 - t1 });
            if (samples.length > 8) samples.shift();
            var best = samples.reduce(function (a, b) { return b.rtt < a.rtt ? b : a; });
            offset = best.offset;
            if (!serverNow.synced) {
                serverNow.synced = true;
                try { window.dispatchEvent(new Event('serverclock')); } catch (e) {}
            }
        });
    }
    function attach(sock) {
        if (!sock || sock.__timeSync) return sock;
        sock.__timeSync = true;
        var burst = function () { for (var i = 0; i < 4; i++) setTimeout(function () { sample(sock); }, i * 250); };
        sock.on('connect', function () { samples = []; burst(); });
        if (sock.connected) burst();
        setInterval(function () { if (sock.connected) sample(sock); }, 30000);
        return sock;
    }
    var orig = window.io;
    if (typeof orig !== 'function') return;
    var wrapped = function () { return attach(orig.apply(this, arguments)); };
    for (var k in orig) { try { wrapped[k] = orig[k]; } catch (e) {} }
    window.io = wrapped;
})();

// What a server device plays: the O2 / reactor alarms with their spoken lines, the win sounds and the
// one-off announcements (communications error, meeting calls).
// The host picks which station plays which sound (host lobby, "Station sounds"); the server tells
// each device what it plays and when an alarm is on, so the page itself doesn't decide.
//
//   const sound = AlarmAudio.create(audioContext, socket);   // serverdevice.js does this
//
// Each alarm has its own chain: the looping alarm and its voice go through one reverb, mixed as set in
// voice.json (volumes, ducking, reverb). The win sound plays dry.
(function () {
    'use strict';

    function impulse(ctx, seconds, decay) {
        const len = Math.max(1, Math.round(ctx.sampleRate * seconds));
        const buf = ctx.createBuffer(2, len, ctx.sampleRate);
        for (let c = 0; c < 2; c++) {
            const d = buf.getChannelData(c);
            for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
        }
        return buf;
    }

    // One alarm (o2 or reactor): its loop and its spoken lines.
    function createChain(ctx, type) {
        let settings = null, alarmBuf = null, alarmSrc = null, wantAlarm = false;
        let speaking = 0, voiceSrc = null;
        const queue = [];

        const bus = ctx.createGain();
        const dry = ctx.createGain(), wet = ctx.createGain(), verb = ctx.createConvolver();
        const alarmGain = ctx.createGain(), voiceGain = ctx.createGain(), master = ctx.createGain();
        alarmGain.connect(bus); voiceGain.connect(bus);
        bus.connect(dry); bus.connect(verb); verb.connect(wet);
        dry.connect(master); wet.connect(master); master.connect(ctx.destination);

        const A = () => (settings && settings.audio) || {};
        const level = () => (speaking ? (A().duckTo ?? 0.35) : 1) * (A().alarmVolume ?? 0.6);
        function setAlarmLevel(ramp) {
            const t = ctx.currentTime;
            alarmGain.gain.cancelScheduledValues(t);
            alarmGain.gain.setTargetAtTime(level(), t, ramp || 0.08);
        }

        const ready = (async function load() {
            try {
                const res = await fetch('/alarm/settings?type=' + type, { cache: 'no-store' });
                if (!res.ok) throw new Error('settings ' + res.status);
                settings = await res.json();
                const r = A().reverb || {};
                verb.buffer = impulse(ctx, Math.max(0.1, r.seconds ?? 2.4), Math.max(0.1, r.decay ?? 2.6));
                const mix = Math.max(0, Math.min(1, r.mix ?? 0.3));
                dry.gain.value = 1 - mix * 0.5;
                wet.gain.value = mix;
                voiceGain.gain.value = A().voiceVolume ?? 1;
                if (settings.alarm) {
                    const data = await (await fetch(settings.alarm)).arrayBuffer();
                    alarmBuf = await ctx.decodeAudioData(data);
                }
            } catch (e) {
                console.warn('Alarm sound unavailable (' + type + '):', e);
            }
            if (wantAlarm) startSource();
        })();

        function startSource() {
            if (!wantAlarm || !alarmBuf || alarmSrc) return;
            alarmSrc = ctx.createBufferSource();
            alarmSrc.buffer = alarmBuf;
            alarmSrc.loop = true;
            alarmSrc.connect(alarmGain);
            // a looping source never ends by itself; if the browser stops it anyway, start it again
            const src = alarmSrc;
            src.onended = () => { if (alarmSrc === src) { alarmSrc = null; if (wantAlarm) startSource(); } };
            alarmGain.gain.setValueAtTime(0, ctx.currentTime);
            alarmSrc.start();
            setAlarmLevel(0.05);
        }
        function stopSource(fade) {
            if (!alarmSrc) return;
            const src = alarmSrc, t = ctx.currentTime;
            alarmSrc = null;
            alarmGain.gain.cancelScheduledValues(t);
            alarmGain.gain.setTargetAtTime(0, t, fade || 0.15);
            src.stop(t + (fade || 0.15) * 5);
        }

        async function playNext() {
            if (speaking || !queue.length) return;
            const url = queue.shift();
            try {
                const buf = await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
                const src = ctx.createBufferSource();
                src.buffer = buf;
                src.connect(voiceGain);
                speaking++; setAlarmLevel(); voiceSrc = src;
                src.onended = () => { speaking--; if (voiceSrc === src) voiceSrc = null; setAlarmLevel(0.25); playNext(); };
                src.start();
            } catch (e) {
                console.warn('Could not play the alarm voice:', e);
                playNext();
            }
        }

        return {
            get busy() { return wantAlarm || speaking > 0 || queue.length > 0; },
            audio: A,
            start() { if (wantAlarm) return; wantAlarm = true; ready.then(startSource); },
            stop(fade) { wantAlarm = false; stopSource(fade); },
            say(url) {
                queue.push(url);
                while (queue.length > 2) queue.shift();   // never fall behind the countdown
                ready.then(playNext);
            },
            hush() {
                queue.length = 0;
                try { if (voiceSrc) voiceSrc.stop(); } catch (e) {}
            }
        };
    }

    function create(ctx, socket) {
        const chains = {};
        const chain = type => chains[type] || (chains[type] = createChain(ctx, type));
        let alarmsOn = [];
        const once = new Map();   // id -> { src, gain } of each one-shot sound playing
        const onceTurn = new Map();   // id -> the latest request for it, so a sound stopped while loading never starts
        const listeners = [];

        function wake() { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); }

        // A sound played once, dry: the end-of-game sound (which first stops everything else) or an
        // announcement such as the communications error or a meeting call. `volume` is its key in voice.json's
        // audio; `id` names it, so stopOnce can end it early, and a new sound with the same id replaces it.
        function stopOnce(id, fade) {
            onceTurn.delete(id);
            const e = once.get(id);
            if (!e) return;
            once.delete(id);
            const t = ctx.currentTime;
            e.gain.gain.cancelScheduledValues(t);
            e.gain.gain.setTargetAtTime(0, t, fade || 0.05);
            try { e.src.stop(t + (fade || 0.05) * 6); } catch (err) {}
        }
        async function playOnce(url, volume, stopAlarms, id) {
            id = id || url;
            const turn = {};
            if (stopAlarms) {
                for (const c of Object.values(chains)) { c.stop(0.05); c.hush(); }
                Object.keys(loops).forEach(stopLoop);
                new Set([...once.keys(), ...onceTurn.keys()]).forEach(k => stopOnce(k));
            }
            onceTurn.set(id, turn);
            try {
                if (ctx.state === 'suspended') await ctx.resume();
                const buf = await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
                let vol = Object.values(chains).map(c => c.audio()[volume]).find(v => v != null);
                if (vol == null) {   // no alarm on this device: read the volume from voice.json anyway
                    try { vol = ((await (await fetch('/alarm/settings?type=reactor', { cache: 'no-store' })).json()).audio || {})[volume]; } catch (e) {}
                }
                if (onceTurn.get(id) !== turn) return;   // stopped, or replaced, meanwhile
                stopOnce(id);
                onceTurn.set(id, turn);
                const src = ctx.createBufferSource(), g = ctx.createGain();
                src.buffer = buf;
                g.gain.value = vol ?? 1;
                src.connect(g); g.connect(ctx.destination);
                const entry = { src, gain: g };
                once.set(id, entry);
                src.onended = () => { if (once.get(id) === entry) once.delete(id); };
                src.start();
            } catch (e) {
                console.warn('Could not play ' + url + ':', e);
            }
        }

        // Sounds that repeat while the server says so (the communications error), with a gap between plays.
        const loops = {};   // id -> { src, gain } once playing, or { loading: true }
        async function startLoop(l) {
            if (loops[l.id]) return;
            const entry = loops[l.id] = { loading: true };
            try {
                const buf = await ctx.decodeAudioData(await (await fetch(l.url)).arrayBuffer());
                if (loops[l.id] !== entry) return;   // stopped while loading
                // the sound plus `gap` seconds of silence, looped
                const padded = ctx.createBuffer(buf.numberOfChannels, buf.length + Math.round(ctx.sampleRate * Math.max(0, l.gap || 0)), buf.sampleRate);
                for (let c = 0; c < buf.numberOfChannels; c++) padded.getChannelData(c).set(buf.getChannelData(c));
                let vol = Object.values(chains).map(ch => ch.audio().announceVolume).find(v => v != null);
                if (vol == null) { try { vol = ((await (await fetch('/alarm/settings?type=reactor', { cache: 'no-store' })).json()).audio || {}).announceVolume; } catch (e) {} }
                if (loops[l.id] !== entry) return;
                const src = ctx.createBufferSource(), g = ctx.createGain();
                src.buffer = padded; src.loop = true;
                g.gain.value = vol ?? 1;
                src.connect(g); g.connect(ctx.destination);
                src.start();
                entry.loading = false; entry.src = src; entry.gain = g;
            } catch (e) {
                if (loops[l.id] === entry) delete loops[l.id];
                console.warn('Could not play ' + l.url + ':', e);
            }
        }
        function stopLoop(id) {
            const e = loops[id];
            delete loops[id];
            if (!e || !e.src) return;
            const t = ctx.currentTime;
            e.gain.gain.setTargetAtTime(0, t, 0.08);
            e.src.stop(t + 0.5);
        }

        // Phones and tablets pause web audio when the screen dims or another app takes the sound. Wake it
        // straight back up while something should be playing, instead of waiting for the next voice line.
        const playing = () => once.size > 0 || Object.keys(loops).length > 0 || Object.values(chains).some(c => c.busy);
        function keepAlive() { if (playing() && ctx.state !== 'running' && ctx.state !== 'closed') ctx.resume().catch(() => {}); }
        ctx.addEventListener('statechange', () => setTimeout(keepAlive, 200));
        document.addEventListener('visibilitychange', keepAlive);
        window.addEventListener('focus', keepAlive);
        ['pointerdown', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, keepAlive, true));
        setInterval(keepAlive, 1000);

        let sounds = [];
        if (socket) {
            socket.on('station_sounds', d => {
                if (!d) return;
                sounds = d.sounds || [];
                alarmsOn = d.alarms || [];
                ['o2', 'reactor'].forEach(type => {
                    if (alarmsOn.includes(type)) { wake(); chain(type).start(); }
                    else if (chains[type]) chains[type].stop();
                });
                const want = d.loops || [];
                Object.keys(loops).forEach(id => { if (!want.some(l => l.id === id)) stopLoop(id); });
                want.forEach(l => { wake(); startLoop(l); });
                listeners.forEach(fn => { try { fn(sounds); } catch (e) { console.error(e); } });
            });
            socket.on('alarm_voice', d => {
                if (!d || !d.url || !d.type) return;
                wake();
                chain(d.type).say(d.url);
            });
            socket.on('win_sound', d => { if (d && d.url) playOnce(d.url, 'winVolume', true, 'win'); });
            socket.on('play_sound', d => { if (d && d.url) { wake(); playOnce(d.url, 'announceVolume', false, d.id); } });
            socket.on('stop_sound', d => { if (d && d.id) stopOnce(d.id, 0.4); });
            // the server's station_sounds says so too; this is a second word that the alarm is over
            socket.on('sabotage_fixed', d => { if (d && chains[d.type]) chains[d.type].stop(); });
        }

        return {
            // Called with this device's sound list whenever the server sends it.
            onSounds(fn) { listeners.push(fn); fn(sounds); }
        };
    }

    window.AlarmAudio = { create: create };
})();

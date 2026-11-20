// The O2 and reactor stations' sound: the looping alarm and the server's spoken lines, mixed together
// through one reverb. The mix (volumes, ducking, reverb) comes from the server's voice.json.
//
//   const alarm = AlarmAudio.create(audioContext, socket);   // after a tap, so the browser allows sound
//   alarm.start();  alarm.stop();                             // the looping alarm
// Spoken lines arrive by themselves over the socket ('alarm_voice').
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

    function create(ctx, socket) {
        let settings = null, alarmBuf = null, alarmSrc = null, wantAlarm = false;
        let speaking = 0;
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
                const res = await fetch('/alarm/settings', { cache: 'no-store' });
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
                console.warn('Alarm sound unavailable:', e);
            }
            if (wantAlarm) startSource();
        })();

        function startSource() {
            if (!alarmBuf || alarmSrc) return;
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
                speaking++; setAlarmLevel();
                src.onended = () => { speaking--; setAlarmLevel(0.25); playNext(); };
                src.start();
            } catch (e) {
                console.warn('Could not play the alarm voice:', e);
                playNext();
            }
        }

        // Phones and tablets pause web audio when the screen dims or another app takes the sound. Wake it
        // straight back up while the alarm should be playing, instead of waiting for the next voice line.
        function keepAlive() { if ((wantAlarm || speaking || queue.length) && ctx.state !== 'running' && ctx.state !== 'closed') ctx.resume().catch(() => {}); }
        ctx.addEventListener('statechange', () => setTimeout(keepAlive, 200));
        document.addEventListener('visibilitychange', keepAlive);
        window.addEventListener('focus', keepAlive);
        ['pointerdown', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, keepAlive, true));
        setInterval(keepAlive, 1000);

        if (socket) {
            socket.on('alarm_voice', d => {
                if (!d || !d.url) return;
                if (ctx.state === 'suspended') ctx.resume().catch(() => {});
                queue.push(d.url);
                while (queue.length > 2) queue.shift();   // never fall behind the countdown
                ready.then(playNext);
            });
        }

        return {
            start() {
                wantAlarm = true;
                if (ctx.state === 'suspended') ctx.resume().catch(() => {});
                ready.then(startSource);
            },
            stop() { wantAlarm = false; stopSource(); }
        };
    }

    window.AlarmAudio = { create: create };
})();

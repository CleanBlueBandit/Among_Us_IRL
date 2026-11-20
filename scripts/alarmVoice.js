// Spoken alarms for the O2 and reactor stations.
//
// When a sabotage's alarm goes off, the server makes up an incident (a random section of the ship, a damaged
// part and an id), speaks a warning, counts down, and says it is stable again once the crew fixes it. The
// speech is made here with Piper (through sherpa-onnx), offline. The stations play it over their alarm sound,
// with reverb, in the browser.
//
// Everything that can be tuned lives in voice.json next to server.js: the voice, how often it speaks, the
// mix, the reverb and every line it can say. Missing keys (or a missing file) fall back to DEFAULTS below.
// The file is read again each time an alarm starts, so edits apply to the next alarm without a restart.
//
// The voice itself (about 80 MB) is downloaded on first start into voice/models/ and reused after that.

import fs from 'fs/promises';
import fss from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

export const DEFAULTS = {
    enabled: true,
    voice: {
        model: 'vits-piper-en_US-lessac-medium',   // any Piper voice from the sherpa-onnx tts-models release
        speaker: 0,
        speed: 0.95,                               // 1 = normal; lower is slower
        downloadUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/{model}.tar.bz2'
    },
    // When the voice speaks, in seconds left on the alarm's countdown. It speaks the "start" line as the
    // alarm goes off, a "countdown" line every `every` seconds, then a "final" line every `finalEvery`
    // seconds once `finalFrom` or fewer are left. A line is skipped if the last one is still being spoken.
    schedule: { every: 15, finalFrom: 10, finalEvery: 5 },
    // Mixed in the station's browser. Volumes are 0-1. While the voice speaks, the alarm drops to duckTo.
    // Reverb goes over the alarm and the voice together: mix is how much of it you hear, seconds how long
    // it rings, decay how fast it fades (higher = shorter, drier room).
    audio: {
        alarmVolume: 0.6,
        voiceVolume: 1,
        duckTo: 0.35,
        reverb: { mix: 0.3, seconds: 2.4, decay: 2.6 }
    },
    // Filled into the lines below: {section}, {part}, {id} are picked once per alarm (so the "stable" line
    // names the same ones), {time} is the time left in words, {seconds} the bare number.
    // In ids, # becomes a random digit and @ a random letter.
    sections: ['Section Alpha', 'Section Bravo', 'Section Charlie', 'Section Delta', 'the Upper Deck', 'the Lower Deck',
        'the Engine Bay', 'the Aft Ring', 'the Forward Ring', 'Module Four', 'Sector Seven', 'the Cargo Hold'],
    reactor: {
        alarm: '/sounds/reactor.mp3',
        audio: { reverb: { mix: 0.3 } },
        ids: ['@-##', 'core #', 'unit @#'],
        parts: ['primary coolant pump', 'containment field', 'control rod assembly', 'core regulator', 'plasma conduit',
            'heat exchanger', 'neutron moderator', 'magnetic stabiliser'],
        start: [
            'Warning! {part} failure in {section}. Reactor meltdown in {time}. Two crewmates, hold the override levers.',
            'Alert! Reactor {id} is critical. The {part} in {section} is offline. Meltdown in {time}.',
            'Emergency! {section} reactor overheating. {part} damaged. Core meltdown in {time}.'
        ],
        countdown: ['Reactor meltdown in {time}.', 'Reactor {id}. Meltdown in {time}.', '{time} to core meltdown.',
            'Warning. {part} offline. Meltdown in {time}.'],
        final: ['{seconds}.'],
        fixed: ['Reactor {id} stable.', '{section} reactor stable. {part} back online.', 'Reactor stabilised. {section} is secure.'],
        failed: ['Reactor meltdown. Containment lost.']
    },
    o2: {
        alarm: '/sounds/o2.mp3',
        audio: { reverb: { mix: 0.15 } },   // this alarm sound already has reverb in it
        ids: ['@-##', 'tank #', 'unit @#'],
        parts: ['oxygen filter', 'carbon dioxide scrubber', 'air recycler', 'pressure regulator', 'electrolysis unit',
            'ventilation fan', 'oxygen tank valve', 'nitrogen mixer'],
        start: [
            'Warning! {part} failure in {section}. Oxygen depleted in {time}. Enter override codes from two crewmates.',
            'Alert! Life support {id} is down. The {part} in {section} has failed. Oxygen depleted in {time}.',
            'Emergency! Oxygen levels falling in {section}. {part} damaged. Oxygen depleted in {time}.'
        ],
        countdown: ['Oxygen depleted in {time}.', 'Life support {id}. Oxygen depleted in {time}.', '{time} of oxygen left.',
            'Warning. {part} offline. Oxygen depleted in {time}.'],
        final: ['{seconds}.'],
        fixed: ['Oxygen restored.', 'Life support {id} stable. {section} oxygen restored.', '{part} back online. Oxygen levels stable.'],
        failed: ['Oxygen depleted. Life support failure.']
    }
};

const TYPES = ['reactor', 'o2'];

// ---- config ----------------------------------------------------------------------------------------
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function merge(base, over) {
    if (!isObj(over)) return base;
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) {
        if (isObj(base[k]) && isObj(v)) out[k] = merge(base[k], v);
        else if (Array.isArray(base[k]) ? Array.isArray(v) && v.length : v !== undefined && v !== null) out[k] = v;
    }
    return out;
}

// ---- words -----------------------------------------------------------------------------------------
const pick = list => (Array.isArray(list) && list.length ? list[crypto.randomInt(list.length)] : '');
const fillId = s => String(s).replace(/#/g, () => String(crypto.randomInt(10))).replace(/@/g, () => String.fromCharCode(65 + crypto.randomInt(26)));
export function timeWords(sec) {
    sec = Math.max(0, Math.round(sec));
    const m = Math.floor(sec / 60), s = sec % 60;
    const parts = [];
    if (m) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
    if (s || !m) parts.push(`${s} second${s === 1 ? '' : 's'}`);
    return parts.join(' ');
}
// Fills a line and capitalises each sentence (a part name may start one).
export function fill(template, vars) {
    const text = String(template || '').replace(/\{(\w+)\}/g, (all, k) => (vars[k] !== undefined ? String(vars[k]) : all));
    return text.replace(/(^\s*|[.!?]\s+)([a-z])/g, (all, pre, ch) => pre + ch.toUpperCase()).trim();
}

// ---- WAV -------------------------------------------------------------------------------------------
function toWav(samples, rate) {
    const buf = Buffer.alloc(44 + samples.length * 2);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
    for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
    return buf;
}

// ---- the voice -------------------------------------------------------------------------------------
// opts: { root, send(type, event, payload), log, logError }
export function createAlarmVoice({ root, send, log = () => {}, logError = console.error }) {
    const CONFIG_FILE = path.join(root, 'voice.json');
    const MODELS_DIR = path.join(root, 'voice', 'models');
    let config = DEFAULTS;
    let engine = null, engineFor = '', loading = null, failedFor = '';
    const incidents = new Map();   // type -> { section, part, id, busyUntil, lastAt }
    const clips = new Map();       // id -> wav Buffer (the last few, served to the stations)

    async function loadConfig() {
        try {
            const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
            config = merge(DEFAULTS, JSON.parse(raw));
        } catch (e) {
            if (e.code !== 'ENOENT') logError('voice.json could not be read, using the defaults:', e.message);
            config = DEFAULTS;
        }
        return config;
    }

    async function download(model, dir) {
        const url = config.voice.downloadUrl.replace('{model}', model);
        log(`Alarm voice: downloading ${model} (about 80 MB, only once)...`);
        const tmp = path.join(MODELS_DIR, `.download-${process.pid}`);
        await fs.rm(tmp, { recursive: true, force: true });
        await fs.mkdir(tmp, { recursive: true });
        try {
            const res = await fetch(url);
            if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
            const bz2 = require('unbzip2-stream');
            const tar = require('tar');
            await pipeline(Readable.fromWeb(res.body), bz2(), tar.x({ cwd: tmp }));
            await fs.rename(path.join(tmp, model), dir);
            log(`Alarm voice: ${model} is ready.`);
        } finally {
            await fs.rm(tmp, { recursive: true, force: true });
        }
    }

    // Loads the voice, downloading it first if needed. Resolves to the engine, or null if it can't run.
    function ensureEngine() {
        const model = config.voice.model;
        if (engine && engineFor === model) return Promise.resolve(engine);
        if (failedFor === model) return Promise.resolve(null);
        if (loading) return loading;
        loading = (async () => {
            try {
                const dir = path.join(MODELS_DIR, model);
                const onnx = path.join(dir, model.replace(/^vits-piper-/, '') + '.onnx');
                if (!fss.existsSync(onnx)) await download(model, dir);
                const sherpa = require('sherpa-onnx-node');
                const tts = await sherpa.OfflineTts.createAsync({
                    model: { vits: { model: onnx, tokens: path.join(dir, 'tokens.txt'), dataDir: path.join(dir, 'espeak-ng-data') }, numThreads: 2, provider: 'cpu', debug: 0 },
                    maxNumSentences: 1
                });
                engine = tts; engineFor = model;
                return engine;
            } catch (e) {
                failedFor = model;
                logError(`Alarm voice: ${model} could not be loaded, the alarms will play without a voice:`, e.message || e);
                return null;
            } finally {
                loading = null;
            }
        })();
        return loading;
    }

    async function speak(type, line, vars) {
        const inc = incidents.get(type);
        const text = fill(line, vars || inc || {});
        if (!text) return;
        const tts = await ensureEngine();
        if (!tts) { send(type, 'alarm_voice', { type, text, url: null }); return; }
        try {
            const out = await tts.generateAsync({ text, sid: config.voice.speaker | 0, speed: Number(config.voice.speed) || 1 });
            const id = crypto.randomBytes(8).toString('hex');
            clips.set(id, toWav(out.samples, out.sampleRate));
            while (clips.size > 24) clips.delete(clips.keys().next().value);
            const seconds = out.samples.length / out.sampleRate;
            if (inc) inc.busyUntil = Date.now() + seconds * 1000 + 400;
            send(type, 'alarm_voice', { type, text, url: `/alarm/voice/${id}.wav`, seconds });
            log(`Alarm voice (${type}): ${text}`);
        } catch (e) {
            logError('Alarm voice: could not speak:', e.message || e);
        }
    }

    return {
        // Load the voice in the background at start-up, so the first alarm doesn't wait for the download.
        async warmUp() {
            await loadConfig();
            if (config.enabled) ensureEngine();
        },
        clip: id => clips.get(id) || null,
        // What a station's browser needs to play the alarm: the sound file and the mix.
        async settings(type) {
            await loadConfig();
            if (!TYPES.includes(type)) return null;
            const t = config[type] || {};
            return { alarm: t.alarm, audio: merge(config.audio, t.audio), voice: !!config.enabled };
        },
        // The alarm went off: pick this alarm's details and say the opening line.
        async start(type, timeLeft) {
            if (!TYPES.includes(type) || incidents.has(type)) return;
            await loadConfig();
            const t = config[type];
            const inc = { section: pick(config.sections), part: pick(t.parts), id: fillId(pick(t.ids)), busyUntil: 0 };
            incidents.set(type, inc);
            if (!config.enabled) return;
            await speak(type, pick(t.start), { ...inc, time: timeWords(timeLeft), seconds: timeLeft });
        },
        // Every second of the alarm's countdown.
        tick(type, timeLeft) {
            const inc = incidents.get(type);
            if (!inc || !config.enabled || timeLeft <= 0) return;
            const s = config.schedule || {}, every = Math.max(1, s.every | 0), finalFrom = s.finalFrom | 0, finalEvery = Math.max(1, s.finalEvery | 0);
            const final = finalFrom > 0 && timeLeft <= finalFrom;
            if (final ? timeLeft % finalEvery !== 0 : timeLeft % every !== 0) return;
            if (Date.now() < inc.busyUntil) return;
            const t = config[type];
            speak(type, pick(final ? t.final : t.countdown), { ...inc, time: timeWords(timeLeft), seconds: timeLeft });
        },
        fixed(type) {
            const inc = incidents.get(type);
            if (!inc) return;
            incidents.delete(type);
            if (config.enabled) speak(type, pick(config[type].fixed), inc);
        },
        failed(type) {
            const inc = incidents.get(type);
            if (!inc) return;
            incidents.delete(type);
            if (config.enabled) speak(type, pick(config[type].failed), inc);
        },
        reset() { incidents.clear(); }
    };
}

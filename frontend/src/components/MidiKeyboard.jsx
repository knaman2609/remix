import { useState, useRef, useEffect, useCallback } from "react";
import * as Tone from "tone";

const INSTRUMENTS = {
  Piano: () => new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "triangle" },
    envelope: { attack: 0.005, decay: 0.3, sustain: 0.4, release: 1.2 },
  }),
  "Electric Piano": () => new Tone.PolySynth(Tone.FMSynth, {
    harmonicity: 3.01,
    modulationIndex: 14,
    oscillator: { type: "triangle" },
    envelope: { attack: 0.002, decay: 0.5, sustain: 0.2, release: 1 },
    modulation: { type: "square" },
    modulationEnvelope: { attack: 0.002, decay: 0.2, sustain: 0, release: 0.5 },
  }),
  Organ: () => new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "sine" },
    envelope: { attack: 0.01, decay: 0.1, sustain: 0.9, release: 0.3 },
  }),
  Synth: () => new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "sawtooth" },
    envelope: { attack: 0.01, decay: 0.2, sustain: 0.6, release: 0.8 },
  }),
  Bass: () => new Tone.MonoSynth({
    oscillator: { type: "fmsquare" },
    envelope: { attack: 0.01, decay: 0.3, sustain: 0.7, release: 0.5 },
    filterEnvelope: { attack: 0.01, decay: 0.1, sustain: 0.5, release: 0.5, baseFrequency: 200, octaves: 2 },
  }),
  Strings: () => new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "fatsawtooth", count: 3, spread: 30 },
    envelope: { attack: 0.4, decay: 0.3, sustain: 0.8, release: 1.5 },
  }),
  Pluck: () => new Tone.PluckSynth({ attackNoise: 1, dampening: 4000, resonance: 0.9 }),
  "Metal Bell": () => new Tone.MetalSynth({
    frequency: 200, envelope: { attack: 0.001, decay: 0.8, release: 0.5 },
    harmonicity: 5.1, modulationIndex: 32, resonance: 4000, octaves: 1.5,
  }),
};

const WHITE_NOTES = ["C", "D", "E", "F", "G", "A", "B"];
const BLACK_NOTES = { C: "C#", D: "D#", F: "F#", G: "G#", A: "A#" };

// QWERTY keys for 2 rows — notes are assigned dynamically based on base octave
const LOWER_ROW = [
  ["z",""], ["s","#"], ["x",""], ["d","#"], ["c",""], ["v",""], ["g","#"], ["b",""], ["h","#"], ["n",""], ["j","#"], ["m",""],
];
const UPPER_ROW = [
  ["q",""], ["2","#"], ["w",""], ["3","#"], ["e",""], ["r",""], ["5","#"], ["t",""], ["6","#"], ["y",""], ["7","#"], ["u",""],
];
const EXTRA_ROW = [
  ["i",""], ["9","#"], ["o",""], ["0","#"], ["p",""],
];

const CHROMATIC = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

function buildKeyMap(baseOctave) {
  const map = {};
  let noteIdx = 0;
  let oct = baseOctave;
  for (const [key] of LOWER_ROW) {
    map[key] = `${CHROMATIC[noteIdx % 12]}${oct + Math.floor(noteIdx / 12)}`;
    noteIdx++;
  }
  noteIdx = 0;
  oct = baseOctave + 1;
  for (const [key] of UPPER_ROW) {
    map[key] = `${CHROMATIC[noteIdx % 12]}${oct + Math.floor(noteIdx / 12)}`;
    noteIdx++;
  }
  noteIdx = 0;
  oct = baseOctave + 2;
  for (const [key] of EXTRA_ROW) {
    map[key] = `${CHROMATIC[noteIdx % 12]}${oct + Math.floor(noteIdx / 12)}`;
    noteIdx++;
  }
  return map;
}

export default function MidiKeyboard({ onClose }) {
  const [instrument, setInstrument] = useState("Piano");
  const [baseOctave, setBaseOctave] = useState(3);
  const [activeNotes, setActiveNotes] = useState(new Set());
  const [reverb, setReverb] = useState(20);
  const synthRef = useRef(null);
  const reverbRef = useRef(null);
  const activeNotesRef = useRef(new Set());

  // Initialize synth
  useEffect(() => {
    reverbRef.current = new Tone.Reverb({ decay: 2, wet: reverb / 100 }).toDestination();
    const synth = INSTRUMENTS[instrument]();
    synth.connect(reverbRef.current);
    synthRef.current = synth;

    return () => {
      synth.dispose();
      reverbRef.current.dispose();
    };
  }, [instrument]);

  // Update reverb wet
  useEffect(() => {
    if (reverbRef.current) reverbRef.current.wet.value = reverb / 100;
  }, [reverb]);

  const noteOn = useCallback(async (note) => {
    await Tone.start();
    if (activeNotesRef.current.has(note)) return;
    activeNotesRef.current.add(note);
    setActiveNotes(new Set(activeNotesRef.current));
    try {
      if (instrument === "Metal Bell") {
        synthRef.current.triggerAttack(Tone.Frequency(note).toFrequency());
      } else {
        synthRef.current.triggerAttack(note);
      }
    } catch (e) {}
  }, [instrument]);

  const noteOff = useCallback((note) => {
    activeNotesRef.current.delete(note);
    setActiveNotes(new Set(activeNotesRef.current));
    try {
      if (instrument === "Metal Bell") {
        synthRef.current.triggerRelease();
      } else {
        synthRef.current.triggerRelease(note);
      }
    } catch (e) {}
  }, [instrument]);

  // Keyboard events — rebuild map when octave changes
  useEffect(() => {
    const keyMap = buildKeyMap(baseOctave);
    const down = (e) => {
      if (e.repeat) return;
      const note = keyMap[e.key.toLowerCase()];
      if (note) { e.preventDefault(); noteOn(note); }
    };
    const up = (e) => {
      const note = keyMap[e.key.toLowerCase()];
      if (note) { e.preventDefault(); noteOff(note); }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [noteOn, noteOff, baseOctave]);

  const isBlack = (note) => note.includes("#");

  // Build all keys for rendering
  const allWhiteKeys = [];
  const allBlackKeys = [];
  let whiteIndex = 0;
  const octaves = [baseOctave, baseOctave + 1, baseOctave + 2];

  for (const oct of octaves) {
    for (const note of WHITE_NOTES) {
      const fullNote = `${note}${oct}`;
      allWhiteKeys.push({ note: fullNote, index: whiteIndex });

      const sharp = BLACK_NOTES[note];
      if (sharp) {
        allBlackKeys.push({ note: `${sharp}${oct}`, whiteIndex });
      }
      whiteIndex++;
    }
  }

  const whiteW = 42;
  const totalW = allWhiteKeys.length * whiteW;

  return (
    <div style={{
      background: "#0a0a0a", borderRadius: 16, padding: 20,
      border: "1px solid #222", marginBottom: 16,
    }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#eee" }}>MIDI Keyboard</div>
          <div style={{ fontSize: 11, color: "#555" }}>Use mouse or keyboard (Z-M = C3-B3, Q-U = C4-B4)</div>
        </div>
        <button onClick={onClose} style={{
          background: "none", border: "1px solid #333", borderRadius: 6,
          color: "#777", fontSize: 18, cursor: "pointer", width: 30, height: 30,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>×</button>
      </div>

      {/* Controls */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        {Object.keys(INSTRUMENTS).map(name => (
          <button key={name} onClick={() => setInstrument(name)} style={{
            background: instrument === name ? "#E24B4A" : "#111",
            border: `1px solid ${instrument === name ? "#E24B4A" : "#2a2a2a"}`,
            borderRadius: 20, padding: "5px 14px", fontSize: 12, cursor: "pointer",
            color: instrument === name ? "#fff" : "#aaa", fontWeight: 500, fontFamily: "inherit",
          }}>{name}</button>
        ))}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: "auto" }}>
          <button onClick={() => setBaseOctave(o => Math.max(1, o - 1))} style={{
            background: "#111", border: "1px solid #2a2a2a", borderRadius: 6,
            padding: "4px 8px", fontSize: 12, cursor: "pointer", color: "#aaa", fontFamily: "inherit",
          }}>−</button>
          <span style={{ fontSize: 11, color: "#aaa", minWidth: 50, textAlign: "center" }}>Oct {baseOctave}–{baseOctave + 2}</span>
          <button onClick={() => setBaseOctave(o => Math.min(6, o + 1))} style={{
            background: "#111", border: "1px solid #2a2a2a", borderRadius: 6,
            padding: "4px 8px", fontSize: 12, cursor: "pointer", color: "#aaa", fontFamily: "inherit",
          }}>+</button>
          <span style={{ fontSize: 11, color: "#333", margin: "0 4px" }}>|</span>
          <span style={{ fontSize: 11, color: "#555" }}>Reverb</span>
          <input type="range" min="0" max="100" value={reverb}
            onChange={e => setReverb(+e.target.value)}
            style={{ width: 64, accentColor: "#E24B4A" }} />
          <span style={{ fontSize: 11, color: "#555", minWidth: 28 }}>{reverb}%</span>
        </div>
      </div>

      {/* Piano keyboard */}
      <div style={{
        position: "relative", height: 160, overflowX: "auto",
        borderRadius: 8, background: "#111",
      }}>
        <div style={{ position: "relative", width: totalW, height: "100%", margin: "0 auto" }}>
          {/* White keys */}
          {allWhiteKeys.map(({ note, index }) => (
            <div
              key={note}
              onMouseDown={() => noteOn(note)}
              onMouseUp={() => noteOff(note)}
              onMouseLeave={() => { if (activeNotes.has(note)) noteOff(note); }}
              style={{
                position: "absolute", left: index * whiteW, top: 0,
                width: whiteW - 2, height: "100%",
                background: activeNotes.has(note)
                  ? "linear-gradient(180deg, #E24B4A 0%, #c43a3a 100%)"
                  : "linear-gradient(180deg, #f8f8f8 0%, #e0e0e0 100%)",
                borderRadius: "0 0 6px 6px",
                border: "1px solid #333",
                cursor: "pointer",
                display: "flex", alignItems: "flex-end", justifyContent: "center",
                paddingBottom: 8, userSelect: "none",
                transition: "background 0.05s",
              }}
            >
              <span style={{
                fontSize: 9, color: activeNotes.has(note) ? "#fff" : "#999",
                fontWeight: 500,
              }}>{note}</span>
            </div>
          ))}

          {/* Black keys */}
          {allBlackKeys.map(({ note, whiteIndex }) => (
            <div
              key={note}
              onMouseDown={(e) => { e.stopPropagation(); noteOn(note); }}
              onMouseUp={() => noteOff(note)}
              onMouseLeave={() => { if (activeNotes.has(note)) noteOff(note); }}
              style={{
                position: "absolute",
                left: whiteIndex * whiteW + whiteW * 0.65,
                top: 0,
                width: whiteW * 0.6,
                height: "60%",
                background: activeNotes.has(note)
                  ? "linear-gradient(180deg, #E24B4A 0%, #8a2020 100%)"
                  : "linear-gradient(180deg, #333 0%, #111 100%)",
                borderRadius: "0 0 4px 4px",
                border: "1px solid #000",
                cursor: "pointer",
                zIndex: 2,
                display: "flex", alignItems: "flex-end", justifyContent: "center",
                paddingBottom: 4, userSelect: "none",
                transition: "background 0.05s",
              }}
            >
              <span style={{ fontSize: 8, color: activeNotes.has(note) ? "#fff" : "#666" }}>{note}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

import { useState, useRef, useCallback, useEffect } from 'react';
import StemLane from './components/StemLane';
import { uploadSong, pollStatus, swapStem, exportMix, healthCheck } from './api';

const STEM_ORDER = ['drums', 'bass', 'vocals', 'other'];

// Simple audio engine using Web Audio API
function createAudioEngine() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const stems = {}; // { name: { buffer, source, gain } }

  return {
    ctx,
    stems,
    async loadStem(name, url) {
      const resp = await fetch(url);
      const arrayBuf = await resp.arrayBuffer();
      const buffer = await ctx.decodeAudioData(arrayBuf);
      const gain = ctx.createGain();
      gain.connect(ctx.destination);
      stems[name] = { buffer, source: null, gain, muted: false, volume: 0.8 };
    },
    play() {
      if (ctx.state === 'suspended') ctx.resume();
      const now = ctx.currentTime + 0.05;
      for (const [name, stem] of Object.entries(stems)) {
        if (stem.source) try { stem.source.stop(); } catch(e) {}
        const source = ctx.createBufferSource();
        source.buffer = stem.buffer;
        source.loop = true;
        source.connect(stem.gain);
        source.start(now);
        stem.source = source;
      }
    },
    stop() {
      for (const stem of Object.values(stems)) {
        if (stem.source) try { stem.source.stop(); stem.source = null; } catch(e) {}
      }
    },
    setVolume(name, value) {
      if (stems[name]) {
        stems[name].volume = value / 100;
        if (!stems[name].muted) stems[name].gain.gain.value = value / 100;
      }
    },
    setMute(name, muted) {
      if (stems[name]) {
        stems[name].muted = muted;
        stems[name].gain.gain.value = muted ? 0 : stems[name].volume;
      }
    },
    dispose() {
      this.stop();
      for (const stem of Object.values(stems)) {
        stem.gain.disconnect();
      }
      ctx.close();
    },
  };
}

export default function App() {
  const [stage, setStage] = useState('upload');     // upload | processing | remix
  const [jobId, setJobId] = useState(null);
  const [fileName, setFileName] = useState('');
  const [progress, setProgress] = useState('');
  const [stems, setStems] = useState({});            // { drums: "/stems/...", ... }
  const [swappedStems, setSwappedStems] = useState({});
  const [swapping, setSwapping] = useState({});      // { drums: true, ... }
  const [duration, setDuration] = useState(30);
  const [isPlaying, setIsPlaying] = useState(false);
  const [error, setError] = useState(null);
  const [exportUrl, setExportUrl] = useState(null);
  const [stemChoices, setStemChoices] = useState({});
  const [backendOk, setBackendOk] = useState(null);
  // Per-stem state: { drums: { muted: false, solo: false, volume: 80, style: 'Original' }, ... }
  const [stemStates, setStemStates] = useState({});
  const engineRef = useRef(null);
  const dragOver = useRef(false);

  // Health check on mount
  useEffect(() => {
    healthCheck()
      .then(data => setBackendOk(data.status))
      .catch(() => setBackendOk('unreachable'));
  }, []);

  // ---------------------------------------------------------------------------
  // Upload
  // ---------------------------------------------------------------------------
  const handleUpload = async (file) => {
    if (!file) return;
    setError(null);
    setFileName(file.name);
    setStage('processing');
    setProgress('Uploading...');

    try {
      const { job_id } = await uploadSong(file);
      setJobId(job_id);
      pollForStems(job_id);
    } catch (err) {
      setError(`Upload failed: ${err.message}`);
      setStage('upload');
    }
  };

  const pollForStems = useCallback(async (jid) => {
    const poll = async () => {
      try {
        const data = await pollStatus(jid);

        if (data.status === 'separating') {
          setProgress('Separating stems with Demucs...');
          setTimeout(poll, 2000);
        } else if (data.status === 'ready') {
          setStems(data.stems);
          setDuration(data.duration || 30);
          setProgress('');
          setStage('remix');
          // Initialize per-stem state
          const initial = {};
          for (const name of Object.keys(data.stems)) {
            initial[name] = { muted: false, solo: false, volume: 80, style: 'Original' };
          }
          setStemStates(initial);
          loadPlayers(data.stems);
        } else if (data.status === 'error') {
          setError(`Demucs error: ${data.error}`);
          setStage('upload');
        } else {
          setProgress(`Status: ${data.status}`);
          setTimeout(poll, 1500);
        }
      } catch (err) {
        setError(`Polling failed: ${err.message}`);
        setStage('upload');
      }
    };
    poll();
  }, []);

  // ---------------------------------------------------------------------------
  // Audio playback with Tone.js Players
  // ---------------------------------------------------------------------------
  const loadPlayers = async (stemUrls) => {
    if (engineRef.current) engineRef.current.dispose();
    const engine = createAudioEngine();
    engineRef.current = engine;

    setProgress('Loading audio buffers...');
    try {
      await Promise.all(
        Object.entries(stemUrls).map(([name, url]) => engine.loadStem(name, url))
      );
      setProgress('');
    } catch (err) {
      setError(`Failed to load stems: ${err.message}`);
      setProgress('');
    }
  };

  const handlePlay = async () => {
    const engine = engineRef.current;
    if (!engine) return;

    if (isPlaying) {
      engine.stop();
      setIsPlaying(false);
    } else {
      engine.play();
      setIsPlaying(true);
    }
  };

  const handleStop = () => {
    if (engineRef.current) engineRef.current.stop();
    setIsPlaying(false);
  };

  // ---------------------------------------------------------------------------
  // Mute / Solo / Volume
  // ---------------------------------------------------------------------------
  const handleMute = (stemName) => {
    setStemStates(prev => {
      const next = { ...prev, [stemName]: { ...prev[stemName], muted: !prev[stemName].muted } };
      if (engineRef.current) engineRef.current.setMute(stemName, next[stemName].muted);
      return next;
    });
  };

  const handleSolo = (stemName) => {
    setStemStates(prev => {
      const wasSolo = prev[stemName]?.solo;
      const next = {};
      for (const [name, state] of Object.entries(prev)) {
        if (name === stemName) {
          next[name] = { ...state, solo: !wasSolo, muted: false };
        } else {
          next[name] = { ...state, solo: false, muted: !wasSolo ? true : false };
        }
      }
      if (engineRef.current) {
        for (const [name, state] of Object.entries(next)) {
          engineRef.current.setMute(name, state.muted);
        }
      }
      return next;
    });
  };

  const handleVolume = (stemName, value) => {
    setStemStates(prev => ({
      ...prev, [stemName]: { ...prev[stemName], volume: value },
    }));
    if (engineRef.current) engineRef.current.setVolume(stemName, value);
  };

  // ---------------------------------------------------------------------------
  // Stem swapping via Lyria
  // ---------------------------------------------------------------------------
  const handleSwap = async (stemName, stylePrompt) => {
    if (!jobId) return;

    setSwapping(prev => ({ ...prev, [stemName]: true }));

    try {
      const result = await swapStem(jobId, stemName, stylePrompt, duration);

      // Update the engine with new audio
      if (engineRef.current) {
        const wasPlaying = isPlaying;
        if (wasPlaying) engineRef.current.stop();
        await engineRef.current.loadStem(stemName, result.url);
        if (wasPlaying) engineRef.current.play();
      }

      // Track the swap
      setSwappedStems(prev => ({ ...prev, [stemName]: result.url }));
      setStemChoices(prev => ({ ...prev, [stemName]: stylePrompt }));
      setStemStates(prev => ({
        ...prev, [stemName]: { ...prev[stemName], style: stylePrompt },
      }));
    } catch (err) {
      setError(`Swap failed: ${err.message}`);
    } finally {
      setSwapping(prev => ({ ...prev, [stemName]: false }));
    }
  };

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------
  const handleExport = async () => {
    if (!jobId) return;
    setProgress('Mixing and exporting...');
    try {
      const result = await exportMix(jobId, stemChoices);
      setExportUrl(result.url);
      setProgress('');
    } catch (err) {
      setError(`Export failed: ${err.message}`);
      setProgress('');
    }
  };

  // ---------------------------------------------------------------------------
  // Preset remixes
  // ---------------------------------------------------------------------------
  const applyPreset = (preset) => {
    const presets = {
      'Jazz':        { drums: 'Jazz Brushes', bass: 'Upright Jazz Bass', vocals: 'Original', other: 'Rhodes Piano' },
      'Lo-fi':       { drums: 'Lo-fi Hip Hop', bass: 'Sub Bass', vocals: 'Pitch Down -3', other: 'Pad Synth Ambient' },
      'Electronic':  { drums: 'Electronic', bass: 'Synth Bass 808', vocals: 'Vocoder Effect', other: 'Pad Synth Ambient' },
      'Acoustic':    { drums: 'Jazz Brushes', bass: 'Acoustic Fingerstyle', vocals: 'Original', other: 'Acoustic Guitar Strum' },
      'Orchestral':  { drums: 'Orchestral Percussion', bass: 'Acoustic Fingerstyle', vocals: 'Choir Harmonies', other: 'String Ensemble' },
    };

    const p = presets[preset];
    if (!p) return;

    Object.entries(p).forEach(([stem, style]) => {
      if (style !== 'Original') handleSwap(stem, style);
    });
  };

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------
  const handleReset = () => {
    handleStop();
    if (engineRef.current) { engineRef.current.dispose(); engineRef.current = null; }
    setStage('upload');
    setJobId(null);
    setStems({});
    setSwappedStems({});
    setStemChoices({});
    setError(null);
    setExportUrl(null);
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div style={{ minHeight: '100vh' }}>
      <div style={{ maxWidth: 660, margin: '0 auto', padding: '24px 16px' }}>

        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ fontSize: 11, letterSpacing: 4, color: '#555', fontWeight: 600, marginBottom: 6 }}>
            REMIX PLAYGROUND
          </div>
          <div style={{
            fontSize: 24, fontWeight: 700,
            background: 'linear-gradient(135deg, #E24B4A, #378ADD, #1D9E75)',
            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
          }}>
            Upload. Split. Swap. Mix.
          </div>
          <div style={{ fontSize: 12, color: '#555', marginTop: 6 }}>
            Demucs stem separation + Lyria AI style swapping
          </div>
          {backendOk && (
            <div style={{
              fontSize: 11, marginTop: 8,
              color: backendOk === 'ok' ? '#1D9E75' : backendOk === 'degraded' ? '#BA7517' : '#E24B4A',
            }}>
              Backend: {backendOk === 'ok' ? '● Connected' : backendOk === 'degraded' ? '● Degraded (some services missing)' : '● Unreachable — start the backend first'}
            </div>
          )}
        </div>

        {/* Error bar */}
        {error && (
          <div style={{
            background: '#E24B4A22', border: '1px solid #E24B4A44', borderRadius: 8,
            padding: '10px 14px', marginBottom: 16, fontSize: 12, color: '#E24B4A',
          }}>
            {error}
            <button onClick={() => setError(null)} style={{
              float: 'right', background: 'none', border: 'none', color: '#E24B4A', cursor: 'pointer', fontSize: 14,
            }}>×</button>
          </div>
        )}

        {/* Upload stage */}
        {stage === 'upload' && (
          <div
            style={{
              border: `2px dashed ${dragOver.current ? '#E24B4A' : '#333'}`,
              borderRadius: 16, padding: '48px 24px', textAlign: 'center',
              cursor: 'pointer', animation: 'slideUp 0.5s ease-out',
              transition: 'border-color 0.2s',
            }}
            onClick={() => document.getElementById('file-input').click()}
            onDragOver={e => { e.preventDefault(); dragOver.current = true; }}
            onDragLeave={() => { dragOver.current = false; }}
            onDrop={e => {
              e.preventDefault();
              dragOver.current = false;
              const file = e.dataTransfer.files[0];
              if (file) handleUpload(file);
            }}
          >
            <input id="file-input" type="file" accept="audio/*" style={{ display: 'none' }}
              onChange={e => handleUpload(e.target.files[0])} />
            <div style={{ fontSize: 40, marginBottom: 12, color: '#E24B4A' }}>♫</div>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Drop a song here</div>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>MP3, WAV, FLAC, OGG — up to 50MB</div>
            <button style={{
              background: '#E24B4A', color: '#fff', border: 'none', borderRadius: 8,
              padding: '10px 24px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}>Choose file</button>
          </div>
        )}

        {/* Processing stage */}
        {stage === 'processing' && (
          <div style={{ textAlign: 'center', padding: '48px 24px', animation: 'slideUp 0.3s ease-out' }}>
            <div style={{
              width: 48, height: 48, border: '3px solid #222', borderTopColor: '#E24B4A',
              borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 20px',
            }} />
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>{progress}</div>
            <div style={{ fontSize: 12, color: '#666' }}>{fileName}</div>
            <div style={{ fontSize: 11, color: '#444', marginTop: 12 }}>
              This can take 30–90 seconds depending on song length
            </div>
          </div>
        )}

        {/* Remix stage */}
        {stage === 'remix' && (
          <div style={{ animation: 'slideUp 0.5s ease-out' }}>

            {/* Transport bar */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              background: '#0a0a0a', borderRadius: 12, padding: '12px 16px', marginBottom: 16,
            }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{fileName}</div>
                <div style={{ fontSize: 11, color: '#666' }}>
                  {STEM_ORDER.filter(s => stems[s]).length} stems · {Math.round(duration)}s
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={handlePlay} style={{
                  background: isPlaying ? '#E24B4A' : '#1D9E75',
                  color: '#fff', border: 'none', borderRadius: 8,
                  padding: '8px 20px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                }}>{isPlaying ? '■ Stop' : '▶ Play'}</button>

                <button onClick={() => { handleStop(); setTimeout(() => handlePlay(), 50); }} style={{
                  background: '#1a1a1a', color: '#aaa', border: '1px solid #333',
                  borderRadius: 8, padding: '8px 16px', fontSize: 13, fontWeight: 500, cursor: 'pointer',
                }}>⟲ Restart</button>

                <button onClick={handleExport} style={{
                  background: '#1a1a1a', color: '#aaa', border: '1px solid #333',
                  borderRadius: 8, padding: '8px 16px', fontSize: 12, fontWeight: 500, cursor: 'pointer',
                }}>Export WAV</button>
              </div>
            </div>

            {progress && (
              <div style={{ textAlign: 'center', fontSize: 12, color: '#888', marginBottom: 12 }}>{progress}</div>
            )}

            {/* Export link */}
            {exportUrl && (
              <div style={{
                background: '#1D9E7522', border: '1px solid #1D9E7544', borderRadius: 8,
                padding: '10px 14px', marginBottom: 16, fontSize: 12, color: '#1D9E75',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
                <span>Mix exported successfully!</span>
                <a href={exportUrl} download style={{
                  color: '#1D9E75', fontWeight: 600, textDecoration: 'none',
                }}>Download WAV ↓</a>
              </div>
            )}

            {/* Stem lanes */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {STEM_ORDER.map(stemName => {
                const url = swappedStems[stemName] || stems[stemName];
                if (!url) return null;
                return (
                  <StemLane
                    key={stemName}
                    stemName={stemName}
                    audioUrl={url}
                    state={stemStates[stemName] || { muted: false, solo: false, volume: 80, style: 'Original' }}
                    onMute={handleMute}
                    onSolo={handleSolo}
                    onVolume={handleVolume}
                    onSwap={handleSwap}
                  />
                );
              })}
            </div>

            {/* AI presets */}
            <div style={{
              marginTop: 16, padding: '14px 16px', background: '#0a0a0a',
              borderRadius: 12, border: '1px solid #1a1a1a',
            }}>
              <div style={{ fontSize: 11, color: '#555', fontWeight: 600, letterSpacing: 1, marginBottom: 8 }}>
                ONE-CLICK REMIXES (calls Lyria for each stem)
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {['Jazz', 'Lo-fi', 'Electronic', 'Acoustic', 'Orchestral'].map(p => (
                  <button key={p} onClick={() => applyPreset(p)} style={{
                    background: '#111', border: '1px solid #2a2a2a', borderRadius: 20,
                    padding: '6px 14px', fontSize: 12, color: '#aaa', cursor: 'pointer', fontWeight: 500,
                  }}>{p}</button>
                ))}
              </div>
            </div>

            {/* Reset */}
            <div style={{ marginTop: 24, textAlign: 'center' }}>
              <button onClick={handleReset} style={{
                background: 'transparent', border: 'none', color: '#555',
                fontSize: 12, cursor: 'pointer',
              }}>
                ← Upload a different song
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

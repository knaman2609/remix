import { useState, useRef, useCallback, useEffect } from 'react';
import StemLane from './components/StemLane';
import MidiKeyboard from './components/MidiKeyboard';
import TrimPreview from './components/TrimPreview';
import { uploadSong, pollStatus, swapStem, exportMix, healthCheck, youtubeDownload, trimAndProcess, fetchLibrary, fetchSwapHistory, suggestMatch } from './api';

const STEM_ORDER = ['drums', 'bass', 'vocals', 'other'];

function YouTubeInput({ onSubmit }) {
  const [url, setUrl] = useState('');

  const handleSubmit = () => {
    if (!url.trim()) return;
    onSubmit(url.trim());
  };

  return (
    <div style={{
      background: '#0a0a0a', borderRadius: 16, padding: '20px 24px',
      border: '1px solid #1a1a1a',
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Paste a YouTube link</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="text" placeholder="https://youtube.com/watch?v=..."
          value={url} onChange={e => setUrl(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSubmit()}
          style={{
            background: '#111', border: '1px solid #333', borderRadius: 8,
            padding: '10px 14px', fontSize: 13, color: '#eee', fontFamily: 'inherit',
            outline: 'none', flex: 1,
          }}
        />
        <button onClick={handleSubmit} style={{
          background: '#E24B4A', color: '#fff', border: 'none', borderRadius: 8,
          padding: '10px 20px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
          whiteSpace: 'nowrap', opacity: url.trim() ? 1 : 0.4,
        }}>Go</button>
      </div>
      <div style={{ fontSize: 11, color: '#555', marginTop: 8 }}>You'll be able to trim and preview before separating</div>
    </div>
  );
}

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
    play(bOffset = 0) {
      if (ctx.state === 'suspended') ctx.resume();
      const now = ctx.currentTime + 0.05;
      for (const [name, stem] of Object.entries(stems)) {
        if (stem.source) try { stem.source.stop(); } catch(e) {}
        const source = ctx.createBufferSource();
        source.buffer = stem.buffer;
        source.loop = true;
        source.connect(stem.gain);
        if (name.startsWith('b_')) {
          if (bOffset >= 0) {
            source.start(now + bOffset);
          } else {
            // seek into buffer so Deck B appears to have started earlier
            const seekTo = (-bOffset) % stem.buffer.duration;
            source.start(now, seekTo);
          }
        } else {
          source.start(now);
        }
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
  const [stage, setStage] = useState('upload');     // upload | trimming | processing | remix
  const [jobId, setJobId] = useState(null);
  const [fileName, setFileName] = useState('');
  const [previewUrl, setPreviewUrl] = useState(null); // audio URL for trim preview
  const [progress, setProgress] = useState('');
  const [stems, setStems] = useState({});            // { drums: "/stems/...", ... }
  const [swappedStems, setSwappedStems] = useState({});
  const [swapping, setSwapping] = useState({});      // { drums: true, ... }
  const [duration, setDuration] = useState(30);
  const [isPlaying, setIsPlaying] = useState(false);
  const [error, setError] = useState(null);
  const [exportUrl, setExportUrl] = useState(null);
  const [stemChoices, setStemChoices] = useState({});
  const [bpm, setBpm] = useState(null);
  const [library, setLibrary] = useState([]);
  const [swapHistory, setSwapHistory] = useState({});
  const [backendOk, setBackendOk] = useState(null);
  const [showKeyboard, setShowKeyboard] = useState(false);
  const [libraryFilter, setLibraryFilter] = useState('');
  const [deckAMuted, setDeckAMuted] = useState(false);
  const [deckBOffset, setDeckBOffset] = useState(0); // seconds
  const [deckBMuted, setDeckBMuted] = useState(false);
  // Per-stem state: { drums: { muted: false, solo: false, volume: 80, style: 'Original' }, ... }
  const [stemStates, setStemStates] = useState({});
  // Second deck state
  const [songB, setSongB] = useState(null); // { jobId, fileName, stems, bpm } | null
  const [stemBStates, setStemBStates] = useState({});
  const [showAddSongB, setShowAddSongB] = useState(false);
  const [loadingB, setLoadingB] = useState(false);
  const [loadingBMsg, setLoadingBMsg] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [trimBData, setTrimBData] = useState(null); // { jobId, audioUrl, fileName, duration }
  const engineRef = useRef(null);
  const dragOver = useRef(false);

  // Health check on mount
  useEffect(() => {
    healthCheck()
      .then(data => setBackendOk(data.status))
      .catch(() => setBackendOk('unreachable'));
    fetchLibrary().then(setLibrary).catch(() => {});
    fetchSwapHistory().then(setSwapHistory).catch(() => {});
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
          setBpm(data.bpm || null);
          setProgress('');
          setStage('remix');
          // Refresh library
          fetchLibrary().then(setLibrary).catch(() => {});
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

  const loadSongBStems = async (stemUrls) => {
    const engine = engineRef.current;
    if (!engine) return;
    setLoadingB(true);
    try {
      await Promise.all(
        Object.entries(stemUrls).map(([name, url]) => engine.loadStem(`b_${name}`, url))
      );
    } catch (err) {
      setError(`Failed to load second song: ${err.message}`);
    } finally {
      setLoadingB(false);
    }
  };

  const loadSongBFromLibrary = async (item) => {
    const initial = {};
    for (const name of Object.keys(item.stems)) {
      initial[name] = { muted: false, solo: false, volume: 80, style: 'Original' };
    }
    setStemBStates(initial);
    setSongB({ jobId: item.job_id, fileName: item.filename, stems: item.stems, bpm: item.bpm });
    setShowAddSongB(false);
    await loadSongBStems(item.stems);
  };

  const loadSongBFromYoutubeUrl = async (url) => {
    setLoadingB(true);
    setLoadingBMsg('Downloading audio…');
    setShowAddSongB(false);
    setSuggestions([]);
    setError(null);
    try {
      const data = await youtubeDownload(url);
      if (data.duration > 300) {
        setError(`Video is ${Math.round(data.duration / 60)} min — max 5 minutes. Pick a shorter one.`);
        setShowAddSongB(true);
        return;
      }
      setTrimBData({ jobId: data.job_id, audioUrl: data.audio_url, fileName: data.filename, duration: data.duration || 60 });
    } catch (err) {
      setError(`Failed to download: ${err.message}`);
      setShowAddSongB(true);
    } finally {
      setLoadingB(false);
      setLoadingBMsg('');
    }
  };

  const confirmTrimB = async (start, end) => {
    const { jobId: jid, fileName: fn } = trimBData;
    setTrimBData(null);
    setLoadingB(true);
    setLoadingBMsg('Separating stems…');
    try {
      await trimAndProcess(jid, start, end);
      const pollB = async () => {
        try {
          const status = await pollStatus(jid);
          if (status.status === 'separating' || status.status === 'uploaded' || status.status === 'processing') {
            setTimeout(pollB, 2000);
          } else if (status.status === 'ready') {
            const initial = {};
            for (const name of Object.keys(status.stems)) {
              initial[name] = { muted: false, solo: false, volume: 80, style: 'Original' };
            }
            setStemBStates(initial);
            setSongB({ jobId: jid, fileName: fn, stems: status.stems, bpm: status.bpm });
            fetchLibrary().then(setLibrary).catch(() => {});
            await loadSongBStems(status.stems);
          } else if (status.status === 'error') {
            setError(`Song B failed: ${status.error}`);
            setLoadingB(false);
          } else {
            setTimeout(pollB, 1500);
          }
        } catch (err) {
          setError(`Song B polling failed: ${err.message}`);
          setLoadingB(false);
        }
      };
      pollB();
    } catch (err) {
      setError(`Trim failed: ${err.message}`);
      setLoadingB(false);
    }
  };

  const loadSongBFromFile = async (file) => {
    setLoadingB(true);
    setError(null);
    setShowAddSongB(false);
    try {
      const { job_id } = await uploadSong(file);
      const pollB = async () => {
        try {
          const data = await pollStatus(job_id);
          if (data.status === 'separating' || data.status === 'uploaded' || data.status === 'processing') {
            setTimeout(pollB, 2000);
          } else if (data.status === 'ready') {
            const initial = {};
            for (const name of Object.keys(data.stems)) {
              initial[name] = { muted: false, solo: false, volume: 80, style: 'Original' };
            }
            setStemBStates(initial);
            setSongB({ jobId: job_id, fileName: file.name, stems: data.stems, bpm: data.bpm });
            fetchLibrary().then(setLibrary).catch(() => {});
            await loadSongBStems(data.stems);
          } else if (data.status === 'error') {
            setError(`Song B separation failed: ${data.error}`);
            setLoadingB(false);
          } else {
            setTimeout(pollB, 1500);
          }
        } catch (err) {
          setError(`Song B polling failed: ${err.message}`);
          setLoadingB(false);
        }
      };
      pollB();
    } catch (err) {
      setError(`Song B upload failed: ${err.message}`);
      setLoadingB(false);
    }
  };

  const handlePlay = async () => {
    const engine = engineRef.current;
    if (!engine) return;

    if (isPlaying) {
      engine.stop();
      setIsPlaying(false);
    } else {
      engine.play(deckBOffset);
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
      if (engineRef.current) engineRef.current.setMute(stemName, deckAMuted || next[stemName].muted);
      return next;
    });
  };

  const handleSolo = (stemName) => {
    setStemStates(prev => {
      const next = {};
      // Toggle solo on the clicked stem
      const toggled = { ...prev, [stemName]: { ...prev[stemName], solo: !prev[stemName].solo } };
      const anySoloed = Object.values(toggled).some(s => s.solo);

      for (const [name, state] of Object.entries(toggled)) {
        if (anySoloed) {
          // If any stems are soloed, mute non-soloed stems
          next[name] = { ...state, muted: !state.solo };
        } else {
          // No solos active — unmute everything
          next[name] = { ...state, muted: false };
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

  const handleMuteB = (stemName) => {
    setStemBStates(prev => {
      const next = { ...prev, [stemName]: { ...prev[stemName], muted: !prev[stemName].muted } };
      if (engineRef.current) engineRef.current.setMute(`b_${stemName}`, deckBMuted || next[stemName].muted);
      return next;
    });
  };

  const handleSoloB = (stemName) => {
    setStemBStates(prev => {
      const toggled = { ...prev, [stemName]: { ...prev[stemName], solo: !prev[stemName].solo } };
      const anySoloed = Object.values(toggled).some(s => s.solo);
      const next = {};
      for (const [name, state] of Object.entries(toggled)) {
        next[name] = anySoloed ? { ...state, muted: !state.solo } : { ...state, muted: false };
      }
      if (engineRef.current) {
        for (const [name, state] of Object.entries(next)) {
          engineRef.current.setMute(`b_${name}`, state.muted);
        }
      }
      return next;
    });
  };

  const handleVolumeB = (stemName, value) => {
    setStemBStates(prev => ({
      ...prev, [stemName]: { ...prev[stemName], volume: value },
    }));
    if (engineRef.current) engineRef.current.setVolume(`b_${stemName}`, value);
  };

  const handleNudgeB = (deltaSeconds) => {
    setDeckBOffset(prev => {
      const next = prev + deltaSeconds;
      if (isPlaying && engineRef.current) {
        engineRef.current.stop();
        engineRef.current.play(next);
      }
      return next;
    });
  };

  const handleDeckAMute = () => {
    const next = !deckAMuted;
    setDeckAMuted(next);
    if (engineRef.current) {
      for (const name of Object.keys(stemStates)) {
        const stemState = stemStates[name];
        engineRef.current.setMute(name, next || stemState.muted);
      }
    }
  };

  const handleDeckBMute = () => {
    const next = !deckBMuted;
    setDeckBMuted(next);
    if (engineRef.current && songB) {
      for (const name of Object.keys(stemBStates)) {
        const stemState = stemBStates[name];
        engineRef.current.setMute(`b_${name}`, next || stemState.muted);
      }
    }
  };

  // ---------------------------------------------------------------------------
  // Stem swapping via Lyria
  // ---------------------------------------------------------------------------
  const handleSwap = async (stemName, stylePrompt) => {
    if (!jobId) return;

    setSwapping(prev => ({ ...prev, [stemName]: true }));

    try {
      let newUrl;

      if (stylePrompt === 'Original') {
        // Revert to the original Demucs stem
        newUrl = stems[stemName];
        setSwappedStems(prev => { const next = { ...prev }; delete next[stemName]; return next; });
        setStemChoices(prev => { const next = { ...prev }; delete next[stemName]; return next; });
      } else {
        const result = await swapStem(jobId, stemName, stylePrompt, duration);
        newUrl = result.url;
        setSwappedStems(prev => ({ ...prev, [stemName]: newUrl }));
        setStemChoices(prev => ({ ...prev, [stemName]: stylePrompt }));
      }

      // Update the engine with new audio
      if (engineRef.current) {
        const wasPlaying = isPlaying;
        if (wasPlaying) engineRef.current.stop();
        await engineRef.current.loadStem(stemName, newUrl);
        if (wasPlaying) engineRef.current.play();
      }

      setStemStates(prev => ({
        ...prev, [stemName]: { ...prev[stemName], style: stylePrompt },
      }));
      // Refresh swap history
      fetchSwapHistory().then(setSwapHistory).catch(() => {});
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
    setPreviewUrl(null);
    setError(null);
    setExportUrl(null);
    setSongB(null);
    setStemBStates({});
    setDeckAMuted(false);
    setDeckBMuted(false);
    setDeckBOffset(0);
    setShowAddSongB(false);
    setLoadingB(false);
    setLoadingBMsg('');
    setSuggestions([]);
    setLoadingSuggestions(false);
    setTrimBData(null);
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div style={{ minHeight: '100vh' }}>
      <div style={{ maxWidth: stage === 'remix' ? 1200 : 660, margin: '0 auto', padding: '24px 16px' }}>

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
          <button onClick={() => setShowKeyboard(!showKeyboard)} style={{
            background: showKeyboard ? '#E24B4A' : '#111', border: `1px solid ${showKeyboard ? '#E24B4A' : '#2a2a2a'}`,
            borderRadius: 20, padding: '5px 14px', fontSize: 11, cursor: 'pointer', marginTop: 10,
            color: showKeyboard ? '#fff' : '#777', fontWeight: 600, fontFamily: 'inherit',
          }}>♫ MIDI Keyboard</button>
        </div>

        {/* MIDI Keyboard */}
        {showKeyboard && <MidiKeyboard onClose={() => setShowKeyboard(false)} />}

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
          <div style={{ animation: 'slideUp 0.5s ease-out' }}>
            {/* File upload */}
            <div
              style={{
                border: `2px dashed ${dragOver.current ? '#E24B4A' : '#333'}`,
                borderRadius: 16, padding: '36px 24px', textAlign: 'center',
                cursor: 'pointer', transition: 'border-color 0.2s',
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

            {/* Divider */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '16px 0' }}>
              <div style={{ flex: 1, height: 1, background: '#222' }} />
              <span style={{ fontSize: 11, color: '#555', fontWeight: 600 }}>OR</span>
              <div style={{ flex: 1, height: 1, background: '#222' }} />
            </div>

            {/* YouTube input */}
            <YouTubeInput onSubmit={async (url) => {
              setError(null);
              setStage('processing');
              setProgress('Downloading from YouTube...');
              try {
                const data = await youtubeDownload(url);
                setJobId(data.job_id);
                setFileName(data.filename);
                setDuration(data.duration || 60);
                setPreviewUrl(data.audio_url);
                setStage('trimming');
                setProgress('');
              } catch (err) {
                setError(`YouTube download failed: ${err.message}`);
                setStage('upload');
              }
            }} />
            {/* Saved stems library */}
            {library.length > 0 && (
              <div style={{ marginTop: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <div style={{ fontSize: 11, letterSpacing: 2, color: '#555', fontWeight: 600 }}>
                    PREVIOUS SESSIONS
                  </div>
                  <span style={{ fontSize: 11, color: '#444' }}>
                    {libraryFilter
                      ? `${library.filter(i => i.filename.toLowerCase().includes(libraryFilter.toLowerCase())).length} / ${library.length}`
                      : `${Math.min(3, library.length)} / ${library.length}`}
                  </span>
                </div>
                <input
                  type="text"
                  placeholder="Filter sessions…"
                  value={libraryFilter}
                  onChange={e => setLibraryFilter(e.target.value)}
                  style={{
                    width: '100%', boxSizing: 'border-box',
                    background: '#111', border: '1px solid #2a2a2a', borderRadius: 8,
                    padding: '8px 12px', fontSize: 12, color: '#eee', fontFamily: 'inherit',
                    outline: 'none', marginBottom: 8,
                  }}
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {(libraryFilter
                    ? library.filter(item => item.filename.toLowerCase().includes(libraryFilter.toLowerCase()))
                    : library.slice(0, 3)
                  ).map(item => (
                    <button key={item.job_id} onClick={() => {
                      setJobId(item.job_id);
                      setFileName(item.filename);
                      setStems(item.stems);
                      setDuration(item.duration || 30);
                      setBpm(item.bpm || null);
                      // Init per-stem state
                      const initial = {};
                      for (const name of Object.keys(item.stems)) {
                        initial[name] = { muted: false, solo: false, volume: 80, style: 'Original' };
                      }
                      setStemStates(initial);
                      loadPlayers(item.stems);
                      setStage('remix');
                    }} style={{
                      background: '#0a0a0a', border: '1px solid #1a1a1a', borderRadius: 10,
                      padding: '10px 14px', cursor: 'pointer', textAlign: 'left',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    }}>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#ccc' }}>{item.filename}</div>
                        <div style={{ fontSize: 11, color: '#555' }}>
                          {Object.keys(item.stems).length} stems · {Math.round(item.duration || 0)}s
                          {item.bpm ? ` · ${item.bpm} BPM` : ''}
                        </div>
                      </div>
                      <span style={{ fontSize: 11, color: '#555' }}>Load →</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Trimming stage — preview + select region */}
        {stage === 'trimming' && previewUrl && (
          <TrimPreview
            audioUrl={previewUrl}
            duration={duration}
            fileName={fileName}
            onCancel={() => { setStage('upload'); setPreviewUrl(null); }}
            onConfirm={async (start, end) => {
              setStage('processing');
              setProgress('Trimming and separating stems...');
              try {
                await trimAndProcess(jobId, start, end);
                pollForStems(jobId);
              } catch (err) {
                setError(`Processing failed: ${err.message}`);
                setStage('upload');
              }
            }}
          />
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
              background: '#161616', borderRadius: 12, padding: '12px 16px', marginBottom: 12,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{fileName}</div>
                    <div style={{ fontSize: 11, color: '#666' }}>{Math.round(duration)}s{bpm ? ` · ${bpm} BPM` : ''}</div>
                  </div>
                  <button onClick={handleDeckAMute} style={{
                    background: deckAMuted ? '#E24B4A33' : '#1a1a1a',
                    border: `1px solid ${deckAMuted ? '#E24B4A' : '#333'}`,
                    borderRadius: 6, padding: '3px 9px', fontSize: 11, fontWeight: 700,
                    cursor: 'pointer', color: deckAMuted ? '#E24B4A' : '#777', fontFamily: 'inherit',
                  }}>M</button>
                </div>
                {songB && (
                  <>
                    <div style={{ fontSize: 18, color: '#333' }}>⇄</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{songB.fileName}</div>
                        <div style={{ fontSize: 11, color: '#666' }}>{songB.bpm ? `${songB.bpm} BPM` : ''}</div>
                      </div>
                      <button onClick={handleDeckBMute} style={{
                        background: deckBMuted ? '#E24B4A33' : '#1a1a1a',
                        border: `1px solid ${deckBMuted ? '#E24B4A' : '#333'}`,
                        borderRadius: 6, padding: '3px 9px', fontSize: 11, fontWeight: 700,
                        cursor: 'pointer', color: deckBMuted ? '#E24B4A' : '#777', fontFamily: 'inherit',
                      }}>M</button>
                      <button onClick={() => {
                        if (engineRef.current) {
                          for (const name of Object.keys(songB.stems)) {
                            const stem = engineRef.current.stems[`b_${name}`];
                            if (stem) {
                              if (stem.source) try { stem.source.stop(); } catch(e) {}
                              stem.gain.disconnect();
                              delete engineRef.current.stems[`b_${name}`];
                            }
                          }
                        }
                        setSongB(null);
                        setStemBStates({});
                        setDeckBOffset(0);
                      }} style={{
                        background: 'none', border: 'none', color: '#555', cursor: 'pointer',
                        fontSize: 14, lineHeight: 1, padding: '2px 4px',
                      }}>✕</button>
                    </div>
                    {/* Beat nudge controls */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      {[
                        { label: '◀◀', delta: -1, title: '−1 beat' },
                        { label: '◀',  delta: -0.25, title: '−¼ beat' },
                        { label: '▶',  delta:  0.25, title: '+¼ beat' },
                        { label: '▶▶', delta:  1, title: '+1 beat' },
                      ].map(({ label, delta, title }) => (
                        <button key={label} title={title}
                          onClick={() => handleNudgeB(delta * (bpm ? 60 / bpm : 0.5))}
                          style={{
                            background: '#111', border: '1px solid #2a2a2a', borderRadius: 5,
                            padding: '2px 7px', fontSize: 10, cursor: 'pointer',
                            color: '#666', fontFamily: 'inherit', lineHeight: 1.6,
                          }}>{label}</button>
                      ))}
                      <span style={{ fontSize: 10, color: deckBOffset !== 0 ? '#378ADD' : '#444', minWidth: 44, textAlign: 'center' }}>
                        {deckBOffset === 0 ? '0 b' : `${deckBOffset > 0 ? '+' : ''}${(deckBOffset / (bpm ? 60 / bpm : 0.5)).toFixed(2)} b`}
                      </span>
                      {deckBOffset !== 0 && (
                        <button onClick={() => handleNudgeB(-deckBOffset)} title="Reset offset"
                          style={{ background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: 11, padding: '0 2px' }}>↺</button>
                      )}
                    </div>
                  </>
                )}
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
                }}>⟲</button>
                <button onClick={handleExport} style={{
                  background: '#1a1a1a', color: '#aaa', border: '1px solid #333',
                  borderRadius: 8, padding: '8px 16px', fontSize: 12, fontWeight: 500, cursor: 'pointer',
                }}>Export WAV</button>
              </div>
            </div>
              {/* BPM metadata row */}
              {songB && bpm && songB.bpm && (
                <>
                  <div style={{ height: 1, background: '#222', margin: '10px 0 8px' }} />
                  <div style={{ fontSize: 11, color: Math.abs(bpm - songB.bpm) <= 3 ? '#1D9E75' : '#BA7517' }}>
                    {Math.abs(bpm - songB.bpm) <= 3 ? `✓ BPM match — ${bpm} BPM` : `⚠ ${Math.abs(bpm - songB.bpm)} BPM off — ${bpm} vs ${songB.bpm}`}
                  </div>
                </>
              )}
            </div>

            {progress && (
              <div style={{ textAlign: 'center', fontSize: 12, color: '#888', marginBottom: 12 }}>{progress}</div>
            )}
            {exportUrl && (
              <div style={{
                background: '#1D9E7522', border: '1px solid #1D9E7544', borderRadius: 8,
                padding: '10px 14px', marginBottom: 12, fontSize: 12, color: '#1D9E75',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
                <span>Mix exported!</span>
                <a href={exportUrl} download style={{ color: '#1D9E75', fontWeight: 600, textDecoration: 'none' }}>Download WAV ↓</a>
              </div>
            )}

            {/* Side-by-side decks */}
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>

              {/* Deck A */}
              <div style={{ flex: 1, minWidth: 0 }}>
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
                        onLoadSwap={async (stemName, style, url) => {
                          if (engineRef.current) {
                            const wasPlaying = isPlaying;
                            if (wasPlaying) engineRef.current.stop();
                            await engineRef.current.loadStem(stemName, url);
                            if (wasPlaying) engineRef.current.play();
                          }
                          setSwappedStems(prev => ({ ...prev, [stemName]: url }));
                          setStemChoices(prev => ({ ...prev, [stemName]: style }));
                          setStemStates(prev => ({ ...prev, [stemName]: { ...prev[stemName], style } }));
                        }}
                        previousSwaps={swapHistory[stemName] || []}
                      />
                    );
                  })}
                </div>
              </div>

              {/* Divider */}
              <div style={{ width: 1, background: '#1a1a1a', alignSelf: 'stretch', flexShrink: 0 }} />

              {/* Deck B */}
              <div style={{ flex: 1, minWidth: 0 }}>
                {songB ? (
                  <div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {STEM_ORDER.map(stemName => {
                        if (!songB.stems[stemName]) return null;
                        return (
                          <StemLane
                            key={`b_${stemName}`}
                            stemName={stemName}
                            audioUrl={songB.stems[stemName]}
                            state={stemBStates[stemName] || { muted: false, solo: false, volume: 80, style: 'Original' }}
                            onMute={handleMuteB}
                            onSolo={handleSoloB}
                            onVolume={handleVolumeB}
                            onSwap={null}
                            previousSwaps={[]}
                          />
                        );
                      })}
                    </div>
                  </div>
                ) : trimBData ? (
                  <TrimPreview
                    audioUrl={trimBData.audioUrl}
                    duration={trimBData.duration}
                    fileName={trimBData.fileName}
                    bpm={bpm}
                    onCancel={() => { setTrimBData(null); setShowAddSongB(true); }}
                    onConfirm={(start, end) => confirmTrimB(start, end)}
                  />
                ) : loadingB ? (
                  <div style={{ textAlign: 'center', padding: '40px 24px', color: '#666', fontSize: 13 }}>
                    <div style={{
                      width: 32, height: 32, border: '3px solid #222', borderTopColor: '#378ADD',
                      borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 12px',
                    }} />
                    {loadingBMsg || 'Loading…'}
                  </div>
                ) : showAddSongB ? (
                  <div style={{ background: '#0a0a0a', borderRadius: 12, padding: '14px', border: '1px solid #1a1a1a' }}>

                    {/* Find BPM Match */}
                    {bpm && (
                      <div style={{ marginBottom: 12 }}>
                        <div style={{ fontSize: 10, color: '#555', fontWeight: 600, letterSpacing: 1, marginBottom: 6 }}>FIND BPM MATCH</div>
                        {suggestions.length === 0 ? (
                          <div style={{ display: 'flex', gap: 6 }}>
                            <input
                              id="bpm-keywords"
                              type="text"
                              placeholder="keywords e.g. hip hop, drake…"
                              style={{
                                flex: 1, background: '#111', border: '1px solid #333', borderRadius: 7,
                                padding: '7px 10px', fontSize: 12, color: '#eee', fontFamily: 'inherit', outline: 'none',
                              }}
                              onKeyDown={e => { if (e.key === 'Enter') document.getElementById('bpm-search-btn').click(); }}
                            />
                            <button
                              id="bpm-search-btn"
                              onClick={async () => {
                                setLoadingSuggestions(true);
                                try {
                                  const kw = document.getElementById('bpm-keywords')?.value || '';
                                  const res = await suggestMatch(jobId, kw);
                                  setSuggestions(res.suggestions);
                                } catch (err) {
                                  setError(`Could not find matches: ${err.message}`);
                                } finally {
                                  setLoadingSuggestions(false);
                                }
                              }}
                              disabled={loadingSuggestions}
                              style={{
                                background: '#1a1a1a', border: '1px solid #378ADD44', borderRadius: 7,
                                padding: '7px 12px', fontSize: 12, color: '#378ADD', cursor: 'pointer',
                                fontWeight: 600, opacity: loadingSuggestions ? 0.6 : 1, whiteSpace: 'nowrap',
                              }}>
                              {loadingSuggestions ? '…' : `✦ ${bpm} BPM`}
                            </button>
                          </div>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                            {suggestions.map((s, i) => (
                              <div key={i} style={{
                                background: '#111', border: '1px solid #378ADD33', borderRadius: 8,
                                padding: '8px 10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
                              }}>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontSize: 12, fontWeight: 600, color: '#ccc', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.title}</div>
                                  <div style={{ fontSize: 11, color: '#555' }}>{s.bpm} BPM</div>
                                </div>
                                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                                  <a href={s.youtube_url} target="_blank" rel="noreferrer" style={{
                                    fontSize: 11, color: '#E24B4A', textDecoration: 'none', fontWeight: 600,
                                  }}>▶ YT</a>
                                  <button onClick={() => loadSongBFromYoutubeUrl(s.youtube_url)} style={{
                                    background: 'none', border: '1px solid #378ADD44', borderRadius: 6,
                                    padding: '3px 10px', fontSize: 11, color: '#378ADD', cursor: 'pointer', fontWeight: 600,
                                  }}>Load</button>
                                </div>
                              </div>
                            ))}
                            <button onClick={() => setSuggestions([])} style={{ background: 'none', border: 'none', color: '#555', fontSize: 11, cursor: 'pointer', textAlign: 'left', marginTop: 2 }}>↺ Refresh</button>
                          </div>
                        )}
                        <div style={{ height: 1, background: '#1a1a1a', margin: '12px 0' }} />
                      </div>
                    )}

                    {/* File upload */}
                    <div
                      style={{ border: '2px dashed #222', borderRadius: 10, padding: '14px', textAlign: 'center', cursor: 'pointer', marginBottom: 10 }}
                      onClick={() => document.getElementById('file-input-b').click()}
                      onDragOver={e => e.preventDefault()}
                      onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) loadSongBFromFile(f); }}
                    >
                      <input id="file-input-b" type="file" accept="audio/*" style={{ display: 'none' }}
                        onChange={e => { if (e.target.files[0]) loadSongBFromFile(e.target.files[0]); }} />
                      <div style={{ fontSize: 11, color: '#555', marginBottom: 6 }}>Or drop / upload a file</div>
                      <button style={{ background: '#1a1a1a', color: '#aaa', border: '1px solid #333', borderRadius: 7, padding: '5px 14px', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>Choose file</button>
                    </div>

                    {/* Library */}
                    {library.filter(item => item.job_id !== jobId).length > 0 && (
                      <div>
                        <div style={{ fontSize: 10, color: '#555', fontWeight: 600, letterSpacing: 1, marginBottom: 6 }}>FROM LIBRARY</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                          {library.filter(item => item.job_id !== jobId).map(item => (
                            <button key={item.job_id} onClick={() => loadSongBFromLibrary(item)} style={{
                              background: '#111', border: '1px solid #2a2a2a', borderRadius: 8,
                              padding: '7px 10px', cursor: 'pointer', textAlign: 'left',
                              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                            }}>
                              <div>
                                <div style={{ fontSize: 12, fontWeight: 600, color: '#ccc' }}>{item.filename}</div>
                                <div style={{ fontSize: 11, color: '#555' }}>{Math.round(item.duration || 0)}s{item.bpm ? ` · ${item.bpm} BPM` : ''}</div>
                              </div>
                              <span style={{ fontSize: 11, color: '#378ADD' }}>Load →</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    <button onClick={() => { setShowAddSongB(false); setSuggestions([]); }} style={{ marginTop: 8, background: 'none', border: 'none', color: '#555', fontSize: 12, cursor: 'pointer' }}>Cancel</button>
                  </div>
                ) : (
                  <button onClick={() => setShowAddSongB(true)} style={{
                    background: '#0a0a0a', border: '1px dashed #333', borderRadius: 10,
                    padding: '40px 20px', fontSize: 13, color: '#444', cursor: 'pointer',
                    fontWeight: 500, width: '100%', display: 'block',
                  }}>+ Add Second Song</button>
                )}
              </div>
            </div>

            {/* Reset */}
            <div style={{ marginTop: 24, textAlign: 'center' }}>
              <button onClick={handleReset} style={{ background: 'transparent', border: 'none', color: '#555', fontSize: 12, cursor: 'pointer' }}>
                ← Upload a different song
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

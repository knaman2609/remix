import { useRef, useEffect, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";
import ZoomPlugin from "wavesurfer.js/dist/plugins/zoom.esm.js";

function formatTime(s) {
  if (!s || !isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

const zoomBtnStyle = {
  background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: 5,
  color: "#aaa", fontSize: 13, fontWeight: 600, cursor: "pointer",
  padding: "2px 9px", fontFamily: "inherit", lineHeight: 1.4,
};

export default function TrimPreview({ audioUrl, duration, fileName, bpm, onConfirm, onCancel }) {
  const waveRef = useRef(null);
  const wsRef = useRef(null);
  const wsRegionsRef = useRef(null);
  const basePxPerSecRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [regionStart, setRegionStart] = useState(0);
  const [regionEnd, setRegionEnd] = useState(Math.min(duration || 30, 60));
  const [zoom, setZoom] = useState(1);

  const beatDuration = bpm ? 60 / bpm : null;

  const applyZoom = (level) => {
    if (!wsRef.current || !basePxPerSecRef.current) return;
    const clamped = Math.max(1, Math.min(level, 20));
    setZoom(clamped);
    wsRef.current.zoom(basePxPerSecRef.current * clamped);
  };

  // Init WaveSurfer with RegionsPlugin + ZoomPlugin
  useEffect(() => {
    if (!waveRef.current || !audioUrl) return;

    const wsRegions = RegionsPlugin.create();
    wsRegionsRef.current = wsRegions;

    const ws = WaveSurfer.create({
      container: waveRef.current,
      waveColor: "#555",
      progressColor: "#E24B4A",
      cursorColor: "#E24B4A",
      barWidth: 2,
      barGap: 1.5,
      barRadius: 2,
      height: 100,
      normalize: true,
      plugins: [wsRegions, ZoomPlugin.create({ scale: 0.5, maxZoom: 500 })],
    });

    ws.load(audioUrl);
    ws.on("audioprocess", () => setCurrentTime(ws.getCurrentTime()));
    ws.on("seeking", () => setCurrentTime(ws.getCurrentTime()));
    ws.on("finish", () => setIsPlaying(false));

    ws.on("ready", () => {
      basePxPerSecRef.current = waveRef.current.clientWidth / ws.getDuration();

      const bd = bpm ? 60 / bpm : null;
      const snap = (t) => (bd ? Math.round(t / bd) * bd : t);

      wsRegions.addRegion({
        start: 0,
        end: Math.min(duration || 30, 60),
        drag: true,
        resize: true,
        color: "rgba(255,255,255,0.05)",
        minLength: bd ?? 0.5,
      });

      wsRegions.on("region-update", (r) => {
        const s = snap(r.start);
        const e = snap(r.end);
        if (s !== r.start || e !== r.end) r.setOptions({ start: s, end: e });
        setRegionStart(s);
        setRegionEnd(e);
      });

      wsRegions.on("region-updated", (r) => {
        const s = snap(r.start);
        const e = snap(r.end);
        r.setOptions({ start: s, end: e });
        setRegionStart(s);
        setRegionEnd(e);
      });
    });

    wsRef.current = ws;
    return () => {
      wsRegionsRef.current = null;
      basePxPerSecRef.current = null;
      ws.destroy();
    };
  }, [audioUrl]);

  const togglePlay = () => {
    if (!wsRef.current) return;
    if (isPlaying) {
      wsRef.current.pause();
    } else {
      const cur = wsRef.current.getCurrentTime();
      if (cur < regionStart || cur >= regionEnd) {
        wsRef.current.seekTo(regionStart / wsRef.current.getDuration());
      }
      wsRef.current.play();
    }
    setIsPlaying(!isPlaying);
  };

  // Stop at region end
  useEffect(() => {
    if (isPlaying && currentTime >= regionEnd) {
      wsRef.current?.pause();
      setIsPlaying(false);
    }
  }, [currentTime, regionEnd, isPlaying]);

  const playRegion = () => {
    if (!wsRef.current) return;
    wsRef.current.seekTo(regionStart / wsRef.current.getDuration());
    wsRef.current.play();
    setIsPlaying(true);
  };

  const selDuration = regionEnd - regionStart;
  const startPct = duration ? (regionStart / duration) * 100 : 0;
  const endPct = duration ? (regionEnd / duration) * 100 : 100;

  return (
    <div style={{
      background: "#0a0a0a", borderRadius: 16, padding: 20,
      border: "1px solid #1a1a1a", animation: "slideUp 0.3s ease-out",
    }}>
      <style>{`
        [part~="region-handle-left"]  { border-left: 3px solid #1D9E75 !important; background: rgba(29,158,117,0.15) !important; width: 5px !important; }
        [part~="region-handle-right"] { border-right: 3px solid #E24B4A !important; background: rgba(226,75,74,0.15) !important; width: 5px !important; }
        [part~="region"] { cursor: grab; }
        [part~="region"]:active { cursor: grabbing; }
      `}</style>

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{fileName}</div>
          <div style={{ fontSize: 11, color: "#666", display: "flex", alignItems: "center", gap: 8 }}>
            Total: {formatTime(duration)} — Select a region to separate
            {beatDuration && (
              <span style={{
                fontSize: 10, fontWeight: 600, color: "#1D9E75",
                background: "#1D9E7522", border: "1px solid #1D9E7544",
                borderRadius: 4, padding: "1px 6px", letterSpacing: 0.5,
              }}>⬡ Snapping to beats · {bpm} BPM</span>
            )}
          </div>
        </div>
        <button onClick={onCancel} style={{
          background: "none", border: "1px solid #333", borderRadius: 6,
          color: "#777", fontSize: 11, cursor: "pointer", padding: "4px 12px", fontFamily: "inherit",
        }}>Cancel</button>
      </div>

      {/* Waveform with region overlay */}
      <div style={{ position: "relative", marginBottom: 6, paddingTop: 20 }}>
        <div ref={waveRef} style={{ borderRadius: 8, overflow: "hidden" }} />

        {/* Beat grid */}
        {beatDuration && duration && Array.from({ length: Math.floor(duration / beatDuration) }, (_, i) => {
          const pct = ((i + 1) * beatDuration / duration) * 100;
          const isBar = (i + 1) % 4 === 0;
          return (
            <div key={i} style={{
              position: "absolute", top: 20, left: `${pct}%`, width: 1, height: "calc(100% - 20px)",
              background: isBar ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.04)",
              pointerEvents: "none", zIndex: 1,
            }} />
          );
        })}

        {/* Dimmed areas outside region */}
        <div style={{
          position: "absolute", top: 20, left: 0, width: `${startPct}%`, height: "calc(100% - 20px)",
          background: "rgba(0,0,0,0.6)", pointerEvents: "none", borderRadius: "8px 0 0 8px",
        }} />
        <div style={{
          position: "absolute", top: 20, right: 0, width: `${100 - endPct}%`, height: "calc(100% - 20px)",
          background: "rgba(0,0,0,0.6)", pointerEvents: "none", borderRadius: "0 8px 8px 0",
        }} />

        {/* Start time label */}
        <div style={{
          position: "absolute", top: 2, left: `${startPct}%`, transform: "translateX(-50%)",
          fontSize: 10, color: "#1D9E75", whiteSpace: "nowrap", fontWeight: 600,
          pointerEvents: "none", zIndex: 6,
        }}>
          {formatTime(regionStart)}
        </div>

        {/* End time label */}
        <div style={{
          position: "absolute", top: 2, left: `${endPct}%`, transform: "translateX(-50%)",
          fontSize: 10, color: "#E24B4A", whiteSpace: "nowrap", fontWeight: 600,
          pointerEvents: "none", zIndex: 6,
        }}>
          {formatTime(regionEnd)}
        </div>
      </div>

      {/* Zoom controls + hint */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6, marginBottom: 10 }}>
        <span style={{ fontSize: 10, color: "#444", marginRight: 4 }}>Scroll to zoom · drag handles to trim</span>
        <span style={{ fontSize: 11, color: "#555" }}>Zoom</span>
        <button onClick={() => applyZoom(zoom / 1.5)} disabled={zoom <= 1} style={{ ...zoomBtnStyle, opacity: zoom <= 1 ? 0.35 : 1 }}>−</button>
        <span style={{ fontSize: 11, color: "#666", minWidth: 32, textAlign: "center" }}>
          {zoom === 1 ? "Fit" : `${zoom.toFixed(1)}×`}
        </span>
        <button onClick={() => applyZoom(zoom * 1.5)} style={zoomBtnStyle}>+</button>
        <button onClick={() => applyZoom(1)} style={{ ...zoomBtnStyle, color: "#555" }}>Reset</button>
      </div>

      {/* Controls */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button onClick={togglePlay} style={{
          background: isPlaying ? "#E24B4A" : "#1D9E75",
          color: "#fff", border: "none", borderRadius: 8,
          padding: "8px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer",
        }}>{isPlaying ? "Pause" : "Play"}</button>

        <button onClick={playRegion} style={{
          background: "#1a1a1a", color: "#aaa", border: "1px solid #333",
          borderRadius: 8, padding: "8px 14px", fontSize: 12, fontWeight: 500, cursor: "pointer",
        }}>Play selection</button>

        <div style={{ fontSize: 12, color: "#888" }}>
          {formatTime(currentTime)}
        </div>

        <div style={{ flex: 1 }} />

        <div style={{ fontSize: 12, color: "#888" }}>
          Selection: {formatTime(selDuration)}
          {selDuration > 120 && <span style={{ color: "#BA7517", marginLeft: 6 }}>Long — Demucs may be slow</span>}
        </div>

        <button onClick={() => onConfirm(regionStart, regionEnd)} style={{
          background: "#E24B4A", color: "#fff", border: "none", borderRadius: 8,
          padding: "8px 20px", fontSize: 13, fontWeight: 700, cursor: "pointer",
        }}>Separate stems</button>
      </div>
    </div>
  );
}

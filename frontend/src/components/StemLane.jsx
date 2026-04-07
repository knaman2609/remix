import React, { useRef, useEffect, useState, memo } from "react";
import WaveSurfer from "wavesurfer.js";

const STYLES = {
  drums: ["Original","Jazz Brushes","Electronic","Lo-fi","Orchestral","Latin"],
  bass: ["Original","Upright Jazz","Synth Bass","Acoustic","Sub Bass","Funk Slap"],
  other: ["Original","Piano","Synth Lead","Strings","Pad","Guitar"],
  vocals: ["Original","Vocoder","Pitched Up","Pitched Down","Whisper","Choir"],
};
const STEM_META = {
  drums:  { color:"#E24B4A", icon:"◉", label:"Drums" },
  bass:   { color:"#378ADD", icon:"◈", label:"Bass" },
  other:  { color:"#1D9E75", icon:"♦", label:"Melody / Other" },
  vocals: { color:"#D4537E", icon:"◎", label:"Vocals" },
};

function StemLane({ stemName, audioUrl, state, onMute, onSolo, onVolume, onSwap }) {
  const waveRef = useRef(null);
  const wsRef = useRef(null);
  const [showStyles, setShowStyles] = useState(false);
  const [swapping, setSwapping] = useState(false);
  const meta = STEM_META[stemName] || { color:"#BA7517", icon:"◇", label:stemName };
  const styles = STYLES[stemName] || STYLES.other;

  useEffect(() => {
    if (!waveRef.current || !audioUrl) return;
    const ws = WaveSurfer.create({
      container: waveRef.current, waveColor: meta.color+"66", progressColor: meta.color,
      cursorColor: "transparent", barWidth: 2, barGap: 1.5, barRadius: 2, height: 52,
      normalize: true, interact: false,
    });
    ws.load(audioUrl);
    ws.setMuted(true);
    wsRef.current = ws;
    return () => ws.destroy();
  }, [audioUrl]);

  useEffect(() => {
    if (waveRef.current) waveRef.current.style.opacity = state.muted ? "0.15" : "1";
  }, [state.muted]);

  const handleSwap = async (style) => {
    setSwapping(true); setShowStyles(false);
    try { await onSwap(stemName, style); } catch(e) { console.error(e); }
    setSwapping(false);
  };

  return (
    <div style={{ background:"#0a0a0a", borderRadius:12, padding:"14px 16px",
      border:`1px solid ${state.solo ? meta.color : "#222"}`, position:"relative" }}>
      {swapping && (
        <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center",
          justifyContent:"center", background:"rgba(0,0,0,0.8)", borderRadius:12, zIndex:5, gap:10 }}>
          <div style={{ width:20, height:20, border:"2px solid #333", borderTopColor:meta.color,
            borderRadius:"50%", animation:"spin 0.7s linear infinite" }}/>
          <span style={{ fontSize:13, color:meta.color, fontWeight:500 }}>Regenerating with Lyria...</span>
        </div>
      )}
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10 }}>
        <div style={{ width:30, height:30, borderRadius:8, background:meta.color+"22",
          display:"flex", alignItems:"center", justifyContent:"center", fontSize:15, color:meta.color }}>{meta.icon}</div>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:13, fontWeight:600, color:"#eee" }}>{meta.label}</div>
          <div style={{ fontSize:11, color:"#666" }}>{state.style||"Original"}</div>
        </div>
        <button onClick={()=>onMute(stemName)} style={{ background:state.muted?"#E24B4A33":"#1a1a1a",
          border:"1px solid #333", borderRadius:6, padding:"4px 10px", fontSize:11, fontWeight:700,
          cursor:"pointer", color:state.muted?"#E24B4A":"#777", fontFamily:"inherit" }}>M</button>
        <button onClick={()=>onSolo(stemName)} style={{ background:state.solo?meta.color+"33":"#1a1a1a",
          border:"1px solid #333", borderRadius:6, padding:"4px 10px", fontSize:11, fontWeight:700,
          cursor:"pointer", color:state.solo?meta.color:"#777", fontFamily:"inherit" }}>S</button>
        <button onClick={()=>setShowStyles(!showStyles)} style={{
          background:state.style&&state.style!=="Original"?meta.color:"#1a1a1a",
          border:`1px solid ${state.style&&state.style!=="Original"?meta.color:"#333"}`,
          borderRadius:6, padding:"4px 12px", fontSize:11, fontWeight:600, cursor:"pointer",
          fontFamily:"inherit", color:state.style&&state.style!=="Original"?"#fff":"#777" }}>Swap ▾</button>
      </div>
      {showStyles && (
        <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:10, padding:"10px 0",
          borderTop:"1px solid #1a1a1a" }}>
          {styles.map(s=>(
            <button key={s} onClick={()=>handleSwap(s)} style={{ background:state.style===s?meta.color:"#111",
              border:`1px solid ${state.style===s?meta.color:"#2a2a2a"}`, borderRadius:20, padding:"5px 14px",
              fontSize:12, cursor:"pointer", color:state.style===s?"#fff":"#aaa", fontWeight:500,
              fontFamily:"inherit" }}>{s}</button>
          ))}
        </div>
      )}
      <div style={{ display:"flex", alignItems:"center", gap:10 }}>
        <div ref={waveRef} style={{ flex:1, transition:"opacity 0.3s" }}/>
        <input type="range" min="0" max="100" value={state.volume}
          onChange={e=>onVolume(stemName,+e.target.value)} style={{ width:64, accentColor:meta.color }}/>
        <span style={{ fontSize:11, color:"#555", minWidth:28, textAlign:"right" }}>{state.volume}%</span>
      </div>
    </div>
  );
}
export default memo(StemLane);

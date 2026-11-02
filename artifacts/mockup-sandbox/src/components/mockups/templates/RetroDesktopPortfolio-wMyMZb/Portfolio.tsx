import { useState, useRef, useCallback, useEffect } from "react";
import proj1 from "./images/proj-1.jpg";
import proj2 from "./images/proj-2.jpg";
import proj3 from "./images/proj-3.jpg";
import proj4 from "./images/proj-4.jpg";
import proj5 from "./images/proj-5.jpg";
import proj6 from "./images/proj-6.jpg";

// ── palette ────────────────────────────────────────────────────────────────
const TITLEBAR_COLORS = [
  ["#a8b8d8", "#c8d8f0"],               // powder blue
  ["#c8a8d8", "#e0c8f0"],               // lilac
  ["#a8c8b8", "#c8e8d8"],               // sage
  ["#d8b8a8", "#f0d8c8"],               // peach
  ["#b8c8a8", "#d8e8c8"],               // pistachio
  ["#c8b8d8", "#e8d8f0"],               // lavender
];

// ── project data ──────────────────────────────────────────────────────────
const PROJECTS = [
  {
    id: 1,
    title: "weather.exe",
    label: "Weather App",
    desc: "Real-time forecasts with animated icons and a 7-day outlook.",
    tags: ["React", "API", "CSS"],
    year: "2024",
    status: "LIVE",
    emoji: "🌤",
    image: proj1,
  },
  {
    id: 2,
    title: "journal.txt",
    label: "Daily Journal",
    desc: "Minimal writing app with local-first storage and mood tracking.",
    tags: ["TypeScript", "IndexedDB"],
    year: "2024",
    status: "WIP",
    emoji: "📓",
    image: proj2,
  },
  {
    id: 3,
    title: "shop.htm",
    label: "Ralph's Knits",
    desc: "Handmade crochet bag shop with floating product cards.",
    tags: ["React", "Tailwind"],
    year: "2025",
    status: "LIVE",
    emoji: "🧶",
    image: proj3,
  },
  {
    id: 4,
    title: "lines.js",
    label: "Cursor Game",
    desc: "Grid lines spin to follow your mouse. Pure canvas API magic.",
    tags: ["Canvas", "Animation"],
    year: "2025",
    status: "LIVE",
    emoji: "〰",
    image: proj4,
  },
  {
    id: 5,
    title: "pixels.bmp",
    label: "Pixel Editor",
    desc: "In-browser pixel art editor with palette swaps and PNG export.",
    tags: ["Canvas", "React"],
    year: "2023",
    status: "DONE",
    emoji: "🎨",
    image: proj5,
  },
  {
    id: 6,
    title: "tunes.wav",
    label: "Music Player",
    desc: "Cassette-style player with visualizer bars and drag-and-drop playlist.",
    tags: ["Web Audio", "DnD"],
    year: "2023",
    status: "DONE",
    emoji: "📼",
    image: proj6,
  },
];

// initial window positions (scattered naturally)
const INITIAL_POS = [
  { x: 40,   y: 48  },
  { x: 460,  y: 24  },
  { x: 880,  y: 58  },
  { x: 65,   y: 460 },
  { x: 500,  y: 480 },
  { x: 910,  y: 445 },
];

// ── 90s beveled border helpers ────────────────────────────────────────────
const BEVEL_OUTER = "2px solid transparent";

function windowShadow(raised: boolean) {
  return raised
    ? "inset -1px -1px 0 #888, inset 1px 1px 0 #fff, 4px 6px 0 rgba(0,0,0,0.18)"
    : "inset 1px 1px 0 #888, inset -1px -1px 0 #fff";
}

// ── Window component ──────────────────────────────────────────────────────
interface WinProps {
  project: typeof PROJECTS[0];
  colorPair: string[];
  pos: { x: number; y: number };
  zIndex: number;
  minimised: boolean;
  onBringFront: () => void;
  onMinimise: () => void;
  onClose: () => void;
  onDragEnd: (x: number, y: number) => void;
}

function Window({ project, colorPair, pos, zIndex, minimised, onBringFront, onMinimise, onClose, onDragEnd }: WinProps) {
  const [localPos, setLocalPos] = useState(pos);
  const dragging = useRef(false);
  const origin = useRef({ mx: 0, my: 0, wx: 0, wy: 0 });

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    origin.current = { mx: e.clientX, my: e.clientY, wx: localPos.x, wy: localPos.y };
    onBringFront();

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      setLocalPos({
        x: origin.current.wx + ev.clientX - origin.current.mx,
        y: origin.current.wy + ev.clientY - origin.current.my,
      });
    };
    const onUp = (ev: MouseEvent) => {
      dragging.current = false;
      onDragEnd(
        origin.current.wx + ev.clientX - origin.current.mx,
        origin.current.wy + ev.clientY - origin.current.my,
      );
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [localPos, onBringFront, onDragEnd]);

  const [c1, c2] = colorPair;

  return (
    <div
      onMouseDown={onBringFront}
      style={{
        position: "absolute",
        left: localPos.x,
        top: localPos.y,
        zIndex,
        width: 290,
        userSelect: "none",
        boxShadow: "4px 6px 0 rgba(0,0,0,0.20)",
        // outer bevel
        outline: "2px solid #fff",
        outlineOffset: "-2px",
        border: "2px solid #888",
        borderRadius: 0,
        background: "#e8e4f4",
      }}
    >
      {/* Title bar */}
      <div
        onMouseDown={onMouseDown}
        style={{
          cursor: "move",
          background: `linear-gradient(90deg, ${c1}, ${c2})`,
          padding: "4px 6px",
          display: "flex",
          alignItems: "center",
          gap: 5,
          borderBottom: "2px solid #888",
        }}
      >
        <span style={{ fontSize: 13, flex: 1, fontFamily: "'Courier New', monospace", fontWeight: "bold", color: "#1a1a2e", letterSpacing: 0.3 }}>
          {project.title}
        </span>
        {/* window controls */}
        {[{ label: "─", action: onMinimise }, { label: "□", action: () => {} }, { label: "✕", action: onClose }].map(({ label, action }) => (
          <button
            key={label}
            onMouseDown={e => e.stopPropagation()}
            onClick={action}
            style={{
              width: 18, height: 16,
              background: "#d8d4e8",
              border: "none",
              outline: "none",
              boxShadow: "inset -1px -1px 0 #888, inset 1px 1px 0 #fff",
              cursor: "pointer",
              fontFamily: "monospace",
              fontSize: 9,
              lineHeight: "16px",
              textAlign: "center",
              color: "#333",
              padding: 0,
              flexShrink: 0,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Body — hidden when minimised */}
      {!minimised && (
        <div style={{ background: "#eeeaf8", borderTop: "1px solid #ccc8e0" }}>

          {/* ── Project image ── */}
          <div style={{
            width: "100%", aspectRatio: "16/10", overflow: "hidden",
            borderBottom: "2px solid #b0a8c8",
            background: "#d8d4f0",
            position: "relative",
          }}>
            <img
              src={project.image}
              alt={project.label}
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
              onError={e => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
            {/* Inset bevel over image */}
            <div style={{
              position: "absolute", inset: 0, pointerEvents: "none",
              boxShadow: "inset 2px 2px 0 rgba(0,0,0,0.18), inset -1px -1px 0 rgba(255,255,255,0.25)",
            }} />
          </div>

          {/* ── Info row ── */}
          <div style={{ padding: "8px 10px 6px", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 6 }}>
            <div>
              <div style={{ fontFamily: "'Courier New', monospace", fontWeight: "bold", fontSize: 11.5, color: "#2a2050", lineHeight: 1.2 }}>
                {project.label}
              </div>
              <div style={{ fontFamily: "sans-serif", fontSize: 10.5, color: "#5a5080", marginTop: 2, lineHeight: 1.4 }}>
                {project.desc}
              </div>
            </div>
            <span style={{
              fontFamily: "monospace", fontSize: 9, padding: "2px 5px", whiteSpace: "nowrap", flexShrink: 0,
              background: project.status === "LIVE" ? "#b8dcc8" : project.status === "WIP" ? "#f0d8a8" : "#ccc8e0",
              color: "#1a1a2e", border: "1px solid rgba(0,0,0,0.12)",
            }}>
              {project.status}
            </span>
          </div>

          {/* ── Tags + status bar ── */}
          <div style={{ padding: "0 10px 8px", display: "flex", flexWrap: "wrap", gap: 3 }}>
            {project.tags.map(t => (
              <span key={t} style={{
                fontFamily: "'Courier New', monospace", fontSize: 9, padding: "1px 5px",
                background: "#d8d4f0", color: "#2a2050",
                boxShadow: "inset -1px -1px 0 #b8b0d8, inset 1px 1px 0 #f0eeff",
              }}>
                {t}
              </span>
            ))}
          </div>

          {/* Status bar */}
          <div style={{
            borderTop: "1px solid #ccc8e0", padding: "4px 10px",
            fontFamily: "monospace", fontSize: 9, color: "#776d99",
            display: "flex", justifyContent: "space-between",
          }}>
            <span>📁 {project.title}</span>
            <span>{project.year} · ▶ open</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Taskbar ───────────────────────────────────────────────────────────────
function Taskbar({ windows, onToggle }: { windows: { id: number; title: string; minimised: boolean; colorPair: string[] }[]; onToggle: (id: number) => void }) {
  const now = new Date();
  const [time, setTime] = useState(`${now.getHours().toString().padStart(2,"0")}:${now.getMinutes().toString().padStart(2,"0")}`);
  useEffect(() => {
    const id = setInterval(() => {
      const d = new Date();
      setTime(`${d.getHours().toString().padStart(2,"0")}:${d.getMinutes().toString().padStart(2,"0")}`);
    }, 10000);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={{
      position: "fixed", bottom: 0, left: 0, right: 0,
      height: 32, background: "#ccc8e0",
      boxShadow: "inset 0 1px 0 #fff, inset 0 2px 0 #b8b0d8",
      display: "flex", alignItems: "center", gap: 4, padding: "0 6px",
      zIndex: 9999, borderTop: "2px solid #888",
    }}>
      {/* Start button */}
      <button style={{
        fontFamily: "'Courier New', monospace", fontWeight: "bold", fontSize: 11,
        padding: "2px 10px", height: 22,
        background: "#c8c4dc",
        boxShadow: "inset -1px -1px 0 #888, inset 1px 1px 0 #fff",
        border: "none", cursor: "pointer", color: "#1a1a2e",
        display: "flex", alignItems: "center", gap: 4,
      }}>
        🌸 Start
      </button>

      <div style={{ width: 2, height: 22, background: "#888", margin: "0 2px", boxShadow: "1px 0 0 #fff" }} />

      {/* Window tabs — only closed windows appear here; click to reopen */}
      {windows.map(w => (
        <button
          key={w.id}
          onClick={() => onToggle(w.id)}
          style={{
            fontFamily: "'Courier New', monospace", fontSize: 10,
            padding: "2px 8px", height: 22, maxWidth: 120,
            background: "#d8d4f0",
            boxShadow: "inset 1px 1px 0 #888, inset -1px -1px 0 #fff",
            border: "none", cursor: "pointer", color: "#1a1a2e",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}
        >
          {w.title}
        </button>
      ))}

      <div style={{ flex: 1 }} />

      {/* Clock */}
      <div style={{
        fontFamily: "'Courier New', monospace", fontSize: 11, color: "#2a2050",
        padding: "2px 8px", height: 22, lineHeight: "18px",
        background: "#d0cce4",
        boxShadow: "inset 1px 1px 0 #888, inset -1px -1px 0 #fff",
      }}>
        {time}
      </div>
    </div>
  );
}

// ── Desktop icons ─────────────────────────────────────────────────────────
const ICONS = [
  { label: "My Projects", emoji: "💾" },
  { label: "About Me",    emoji: "👤" },
  { label: "Contact",     emoji: "✉️"  },
  { label: "Recycle Bin", emoji: "🗑"  },
];

// ── Main export ───────────────────────────────────────────────────────────
export default function Portfolio() {
  const [positions, setPositions] = useState(INITIAL_POS.map((p, i) => ({ ...p, id: PROJECTS[i].id })));
  const [zOrders, setZOrders]     = useState<number[]>(PROJECTS.map((_, i) => i + 1));
  const [minimised, setMinimised] = useState<Set<number>>(new Set());
  const [closed, setClosed]       = useState<Set<number>>(new Set());
  const maxZ = useRef(PROJECTS.length);

  const bringFront = (id: number) => {
    maxZ.current++;
    setZOrders(prev => prev.map((z, i) => PROJECTS[i].id === id ? maxZ.current : z));
  };

  const toggleMinimise = (id: number) => {
    setMinimised(prev => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); bringFront(id); }
      else next.add(id);
      return next;
    });
  };

  const closeWindow  = (id: number) => setClosed(prev => new Set([...prev, id]));
  const reopenWindow = (id: number) => {
    setClosed(prev => { const n = new Set(prev); n.delete(id); return n; });
    bringFront(id);
  };

  const updatePos = (id: number, x: number, y: number) => {
    setPositions(prev => prev.map(p => p.id === id ? { ...p, x, y } : p));
  };

  const visible = PROJECTS.filter(p => !closed.has(p.id));

  return (
    <div style={{
      width: "100vw", height: "100vh", overflow: "hidden", position: "relative",
      backgroundColor: "#fff0f4",
      backgroundImage: `
        linear-gradient(to right, #fce8ef 1px, transparent 1px),
        linear-gradient(to bottom, #fce8ef 1px, transparent 1px),
        linear-gradient(to right, transparent 13px, #fce8ef 13px, #fce8ef 14px, transparent 14px),
        linear-gradient(to bottom, transparent 13px, #fce8ef 13px, #fce8ef 14px, transparent 14px)
      `.trim(),
      backgroundSize: "28px 28px, 28px 28px, 28px 28px, 28px 28px",
      backgroundPosition: "14px 0, 0 14px, 0 0, 0 0",
      fontFamily: "sans-serif",
      cursor: "default",
    }}>

      {/* Desktop label */}
      <div style={{
        position: "absolute", top: 18, left: "50%", transform: "translateX(-50%)",
        fontFamily: "'Courier New', monospace", fontSize: 13, color: "rgba(40,32,80,0.45)",
        letterSpacing: "0.18em", textTransform: "uppercase", pointerEvents: "none",
        userSelect: "none",
      }}>
        ✦ my portfolio ✦
      </div>

      {/* Right-side desktop icons */}
      <div style={{ position: "absolute", top: 16, right: 12, display: "flex", flexDirection: "column", gap: 18 }}>
        {ICONS.map(ic => (
          <div key={ic.label} style={{
            display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
            width: 60, cursor: "pointer",
          }}>
            <div style={{
              width: 40, height: 40,
              background: "rgba(255,255,255,0.35)",
              boxShadow: "inset -1px -1px 0 rgba(0,0,0,0.15), inset 1px 1px 0 rgba(255,255,255,0.7)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 22,
            }}>
              {ic.emoji}
            </div>
            <span style={{
              fontFamily: "'Courier New', monospace", fontSize: 9.5, color: "#2a2050",
              textAlign: "center", lineHeight: 1.2,
              textShadow: "0 1px 0 rgba(255,255,255,0.6)",
            }}>
              {ic.label}
            </span>
          </div>
        ))}
      </div>

      {/* Windows */}
      {visible.map((project, i) => {
        const colorPair = TITLEBAR_COLORS[project.id % TITLEBAR_COLORS.length];
        const pos = positions.find(p => p.id === project.id) ?? INITIAL_POS[i];
        const z = zOrders[i] ?? i + 1;
        return (
          <Window
            key={project.id}
            project={project}
            colorPair={colorPair}
            pos={pos}
            zIndex={z}
            minimised={minimised.has(project.id)}
            onBringFront={() => bringFront(project.id)}
            onMinimise={() => toggleMinimise(project.id)}
            onClose={() => closeWindow(project.id)}
            onDragEnd={(x, y) => updatePos(project.id, x, y)}
          />
        );
      })}

      {/* Taskbar — only shows X'd windows */}
      <Taskbar
        windows={PROJECTS.filter(p => closed.has(p.id)).map(p => ({
          id: p.id,
          title: p.title,
          colorPair: TITLEBAR_COLORS[p.id % TITLEBAR_COLORS.length],
        }))}
        onToggle={reopenWindow}
      />
    </div>
  );
}


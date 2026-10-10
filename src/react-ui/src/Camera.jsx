import React, { useState } from "react";

export default function Camera() {
  const [cross, setCross] = useState(() => { try { return localStorage.getItem("next-cross") === "1"; } catch { return false; } });
  const [broken, setBroken] = useState(false);
  const toggle = () => { setCross((c) => { try { localStorage.setItem("next-cross", c ? "0" : "1"); } catch {} return !c; }); };
  return (
    <div className="camera">
      <div className="files-head"><button onClick={toggle}>{cross ? "Hide crosshair" : "Show crosshair"}</button><button onClick={() => setBroken(false)}>Reconnect</button></div>
      {broken ? <p className="empty">No camera image. Plug a camera into a USB port on the controller.</p> : (
        <div className="cam"><img src={`/api/video?${broken ? "x" : ""}`} alt="Camera view" onError={() => setBroken(true)} />{cross && <div className="cross" />}</div>
      )}
    </div>
  );
}

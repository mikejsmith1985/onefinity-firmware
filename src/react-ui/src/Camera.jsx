import React, { useState } from "react";

export default function Camera() {
  const [cross, setCross] = useState(() => { try { return localStorage.getItem("next-cross") === "1"; } catch { return false; } });
  const [broken, setBroken] = useState(false);
  const imgRef = React.useRef(null);
  const snap = () => {
    const im = imgRef.current; if (!im || !im.naturalWidth) return;
    const cv = document.createElement("canvas"); cv.width = im.naturalWidth; cv.height = im.naturalHeight;
    cv.getContext("2d").drawImage(im, 0, 0);
    cv.toBlob((b) => {
      if (!b) return;
      const a = document.createElement("a"), t = new Date(), p = (n) => String(n).padStart(2, "0");
      a.href = URL.createObjectURL(b); a.download = `snapshot-${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}.png`;
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }, "image/png");
  };
  const toggle = () => { setCross((c) => { try { localStorage.setItem("next-cross", c ? "0" : "1"); } catch {} return !c; }); };
  return (
    <div className="camera">
      <div className="files-head"><button onClick={toggle}>{cross ? "Hide crosshair" : "Show crosshair"}</button><button onClick={() => setBroken(false)}>Reconnect</button><button disabled={broken} onClick={snap}>Save snapshot</button></div>
      {broken ? <p className="empty">No camera image. Plug a camera into a USB port on the controller.</p> : (
        <div className="cam"><img ref={imgRef} src={`/api/video?${broken ? "x" : ""}`} alt="Camera view" onError={() => setBroken(true)} />{cross && <div className="cross" />}</div>
      )}
    </div>
  );
}

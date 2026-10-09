import React, { useState } from "react";
import DepthView from "./DepthView.jsx";
import GCode from "./GCode.jsx";
import Files from "./Files.jsx";

const TABS = [["depth", "Depth view"], ["gcode", "G-code"], ["files", "Files"]];

export default function Workspace({ state, path, pathBusy }) {
  const [tab, setTab] = useState("depth");
  return (
    <div className="work">
      <div className="tabs" role="tablist">
        {TABS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      <div className="pane">
        {tab === "depth" && <DepthView path={path} busy={pathBusy} />}
        {tab === "gcode" && <GCode state={state} />}
        {tab === "files" && <Files state={state} />}
      </div>
    </div>
  );
}

// A/B SD card (1.47.0): two complete systems on one card, made, filled,
// tried and switched from here.  The controller side is scripts/ab-card.
import React, { useEffect, useRef, useState } from "react";
import { api } from "./controller.js";
import { Group, Modal, Confirm } from "./ui.jsx";

const gb = (b) => (b ? `${(b / 1e9).toFixed(1)} GB` : "—");
const S = (x) => x?.toUpperCase();

function upload(file, sha, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("PUT", `/api/abcard/upload${sha ? `?sha256=${encodeURIComponent(sha)}` : ""}`);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => (x.status < 300 ? resolve() : reject(new Error((() => { try { return JSON.parse(x.responseText).message; } catch { return x.responseText || `Upload failed (${x.status})`; } })())));
    x.onerror = () => reject(new Error("The upload was cut off"));
    x.send(file);
  });
}

export function SdCard({ state }) {
  const [st, setSt] = useState(null);
  const [err, setErr] = useState("");
  const [dlg, setDlg] = useState(null);
  const [target, setTarget] = useState("");
  const [sha, setSha] = useState("");
  const [file, setFile] = useState(null);
  const [sending, setSending] = useState(null);
  const [restarting, setRestarting] = useState("");
  const fileIn = useRef(null);
  const idle = (state?.cycle || "idle") === "idle";
  const running = st?.job?.state === "running";

  const load = () => api.get("abcard").then((s) => { setSt(s); setErr(""); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  useEffect(() => { const t = setInterval(load, running || sending !== null ? 1500 : 8000); return () => clearInterval(t); }, [running, sending]);
  useEffect(() => { if (st && !st.targets.some((t) => t.device === target)) setTarget(st.targets[0]?.device || ""); }, [st]);

  const act = async (body, after) => {
    setDlg(null); setErr("");
    try { await api.put("abcard", body); after?.(); load(); } catch (e) { setRestarting(""); setErr(e.message.startsWith("{") ? JSON.parse(e.message).message : e.message); }
  };
  const sendFile = async () => {
    setDlg(null); setErr(""); setSending(0);
    try { await upload(file, sha.trim(), setSending); } catch (e) { setErr(e.message); }
    setSending(null); load();
  };

  if (!st) return <Group title="SD card">{err ? <p className="err">{err}</p> : <p className="dim">Reading the card…</p>}</Group>;
  const tgt = st.targets.find((t) => t.device === target);
  const job = st.job;
  const jobBox = job && (
    <div className="abjob" role="status">
      <p><b>{{ make: "Making an A/B card", copy: "Copying into the other slot", write: "Writing the OS file" }[job.action] || job.action}</b>{job.state === "done" ? " — finished" : job.state === "error" ? " — failed" : ""}</p>
      {job.state === "running" && <div className="bar"><i style={{ width: `${job.progress}%` }} /></div>}
      <p className={job.state === "error" ? "err" : "dim"}>{job.message}</p>
      {job.state === "done" && job.action === "make" && (
        <ol className="abwhat">
          <li>Shut the controller down.</li>
          <li>Take the old card out of the SD slot and keep it somewhere safe. It is your way back.</li>
          <li>Put the new card from the reader into the SD slot and start the controller.</li>
          <li>If it doesn't start, shut down and put the old card back. Nothing on it was changed.</li>
        </ol>
      )}
    </div>
  );
  const busyNote = !idle ? <p className="warn-text">Wait until the machine is idle.</p> : null;

  const makeCard = (
    <Group title={st.ab ? "Copy to another card" : "Make an A/B card"}>
      {!st.ab && <>
        <p>An A/B card holds two complete systems, slot A and slot B. One runs while the other can be filled with something new, tried, and kept or dropped. If a trial goes wrong, turning the controller off and on brings back the slot you were on.</p>
        <p>The controller makes the new card itself, from this running system: settings, Wi-Fi, calibration and probe reference included. This card isn't changed.</p>
      </>}
      {st.targets.length === 0 ? <p className="dim">Plug a USB SD card reader into the controller, with a new card in it: 8 GB or larger (32 GB leaves room for two big systems).</p> : <>
        <label className="stack">Card in the reader
          <select value={target} onChange={(e) => setTarget(e.target.value)}>{st.targets.map((t) => <option key={t.device} value={t.device}>{t.model} — {gb(t.size)} ({t.device})</option>)}</select>
        </label>
        <div className="btnrow"><button className="primary" disabled={!idle || running || !tgt} onClick={() => setDlg("make")}>{st.ab ? "Copy this system to that card" : "Make the A/B card"}</button></div>
      </>}
      {busyNote}
    </Group>
  );

  if (!st.ab) return (
    <div className="cols">
      <div>
        <Group title="This card">
          <dl className="stats one">
            <div className="stat"><dt>Type</dt><dd>Single system</dd></div>
            <div className="stat"><dt>Size</dt><dd>{gb(st.card_size)}</dd></div>
            <div className="stat"><dt>System</dt><dd>{st.os || "—"}</dd></div>
            <div className="stat"><dt>Boot firmware</dt><dd>{st.firmware || "—"}</dd></div>
          </dl>
        </Group>
        {jobBox}
        {err && <p className="err">{err}</p>}
      </div>
      <div>{makeCard}</div>
      {dlg === "make" && <MakeConfirm tgt={tgt} onCancel={() => setDlg(null)} onConfirm={() => act({ action: "make", device: target })} />}
    </div>
  );

  const other = st.other, cur = st.running;
  const os = st.slots[other];
  const slotRow = (x) => {
    const s = st.slots[x];
    return (
      <div key={x} className={`abslot${x === cur ? " on" : ""}`}>
        <div className="abhead"><b>Slot {S(x)}</b>
          {x === cur && <span className="flag ok">Running</span>}
          {x === st.default && <span className="flag">Starts normally</span>}
          {x === cur && st.trial && <span className="flag warn">On trial</span>}
        </div>
        {s.bootable ? <p>{s.label || "System"}{s.version ? ` · v${s.version}` : ""}<br /><small className="dim">{s.os || ""}{s.written ? ` · written ${s.written}` : ""}</small></p> : <p className="dim">Empty</p>}
      </div>
    );
  };

  return (
    <div className="cols">
      <div>
        {st.trial && (
          <div className="abtrial" role="alert">
            <p><b>Slot {S(cur)} is on trial.</b> Restarting or turning the controller off and on goes back to slot {S(st.default)}.</p>
            <div className="btnrow"><button className="primary" disabled={!idle} onClick={() => setDlg("keep")}>Keep slot {S(cur)}</button><button disabled={!idle} onClick={() => setDlg("back")}>Go back to slot {S(st.default)}</button></div>
          </div>
        )}
        {st.trial_ended && (
          <div className="abtrial" role="alert">
            <p>Slot {S(st.trial_ended.slot)} was to be tried at {st.trial_ended.time}, but the controller is running slot {S(cur)}. Either slot {S(st.trial_ended.slot)} did not start, or the controller was restarted during the trial.</p>
            <div className="btnrow"><button onClick={() => act({ action: "dismiss" })}>OK</button></div>
          </div>
        )}
        <Group title="A/B card">
          {["a", "b"].map(slotRow)}
          <dl className="stats one">
            <div className="stat"><dt>Card size</dt><dd>{gb(st.card_size)}</dd></div>
            <div className="stat"><dt>Boot firmware</dt><dd>{st.firmware || "—"}</dd></div>
          </dl>
        </Group>
        {jobBox}
        {sending !== null && <div className="abjob" role="status"><p><b>Sending the OS file</b></p><div className="bar"><i style={{ width: `${Math.round(sending * 100)}%` }} /></div></div>}
        {err && <p className="err">{err}</p>}
      </div>
      <div>
        <Group title={`Slot ${S(other)}`}>
          {st.trial ? <p className="dim">Keep slot {S(cur)} or go back first. Slot {S(other)} is the one you know works.</p> : <>
            <div className="btnrow">
              <button disabled={!idle || running || sending !== null} onClick={() => setDlg("copy")}>Copy this system into slot {S(other)}</button>
              <button disabled={!idle || running || sending !== null} onClick={() => fileIn.current.click()}>Load an OS file into slot {S(other)}</button>
              <input ref={fileIn} type="file" hidden accept=".tar,.gz,.tgz,.bz2,.xz" onChange={(e) => { if (e.target.files[0]) { setFile(e.target.files[0]); setSha(""); setDlg("file"); } e.target.value = ""; }} />
            </div>
            <div className="btnrow">
              <button className="primary" disabled={!idle || running || !os.bootable} onClick={() => setDlg("try")}>Try slot {S(other)}</button>
              <button disabled={!idle || running || !os.bootable} onClick={() => setDlg("switch")}>Start from slot {S(other)}</button>
            </div>
            <p className="dim"><b>Try</b> restarts into slot {S(other)} once; turning the controller off and on comes back to slot {S(cur)}. <b>Start from</b> makes slot {S(other)} the one that starts normally.</p>
          </>}
          {busyNote}
        </Group>
        {makeCard}
      </div>

      {dlg === "make" && <MakeConfirm tgt={tgt} onCancel={() => setDlg(null)} onConfirm={() => act({ action: "make", device: target })} />}
      {dlg === "copy" && <Confirm title={`Copy into slot ${S(other)}?`} confirmLabel="Copy" danger={os.bootable} onCancel={() => setDlg(null)} onConfirm={() => act({ action: "copy" })}>
        <p>Slot {S(other)} gets a copy of this running system.{os.bootable ? ` What is in slot ${S(other)} now (${os.label || "a system"}) is erased.` : ""}</p></Confirm>}
      {dlg === "file" && (
        <Modal title={`Load into slot ${S(other)}?`} onClose={() => setDlg(null)} actions={<><button onClick={() => setDlg(null)}>Cancel</button><button className={os.bootable ? "danger" : "primary"} onClick={sendFile}>Load</button></>}>
          <p><em>{file?.name}</em> ({gb(file?.size)}) is written into slot {S(other)}. This system's settings, Wi-Fi, calibration and probe reference are copied across with it.{os.bootable ? ` What is in slot ${S(other)} now is erased.` : ""}</p>
          <label className="stack">SHA-256 checksum (optional)<input value={sha} onChange={(e) => setSha(e.target.value)} placeholder="64 hex digits, from the release page" /><small>With a checksum the file is checked before anything is written.</small></label>
        </Modal>
      )}
      {dlg === "try" && <Confirm title={`Try slot ${S(other)}?`} confirmLabel="Restart and try" onCancel={() => setDlg(null)} onConfirm={() => { setRestarting(`Restarting into slot ${S(other)}. Reconnect in about a minute.`); act({ action: "try" }); }}>
        <p>The controller restarts into slot {S(other)} ({os.label || "system"}). Check it over, then come back here to keep it.</p>
        <p>To go back, restart or turn the controller off and on: it starts slot {S(cur)} again.</p></Confirm>}
      {dlg === "switch" && <Confirm title={`Start from slot ${S(other)}?`} confirmLabel="Switch and restart" onCancel={() => setDlg(null)} onConfirm={() => { setRestarting(`Restarting into slot ${S(other)}. Reconnect in about a minute.`); act({ action: "switch", slot: other }); }}>
        <p>Slot {S(other)} becomes the one that starts normally, without a trial. To come back, use this page on slot {S(other)}.</p></Confirm>}
      {dlg === "keep" && <Confirm title={`Keep slot ${S(cur)}?`} confirmLabel="Keep" onCancel={() => setDlg(null)} onConfirm={() => act({ action: "keep" })}>
        <p>Slot {S(cur)} becomes the one that starts normally. Slot {S(st.default)} stays as it is, and you can switch back to it here later.</p></Confirm>}
      {dlg === "back" && <Confirm title={`Go back to slot ${S(st.default)}?`} confirmLabel="Restart" onCancel={() => setDlg(null)} onConfirm={() => { setDlg(null); setRestarting(`Restarting into slot ${S(st.default)}. Reconnect in about a minute.`); api.put("reboot").catch((e) => { setRestarting(""); setErr(e.message); }); }}>
        <p>The controller restarts into slot {S(st.default)}. Slot {S(cur)} stays as it is.</p></Confirm>}
      {restarting && <Modal title="Restarting" dismissable={false}><p>{restarting}</p></Modal>}
    </div>
  );
}

function MakeConfirm({ tgt, onCancel, onConfirm }) {
  return (
    <Confirm title="Erase that card?" confirmLabel="Erase and make the card" danger onCancel={onCancel} onConfirm={onConfirm}>
      <p>Everything on <b>{tgt?.model} ({gb(tgt?.size)})</b> is erased. The card in the controller's SD slot isn't changed.</p>
      <p>Copying can take a while, depending on the card and the reader. Leave the machine idle until it finishes.</p>
    </Confirm>
  );
}

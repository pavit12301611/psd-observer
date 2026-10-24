import { useState } from 'react';
import { ArrowRight, LoaderCircle, Monitor, ShieldCheck, Info } from 'lucide-react';
import { api } from '../core/api';
import { isNative } from '../core/native';
import { Modal } from './ui';
export default function Pairing({ onClose, onConnected }: { onClose: () => void; onConnected: () => void }) {
  const [address, setAddress] = useState(''), [pin, setPin] = useState(''), [lan, setLan] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <Modal title="Meet your other half." subtitle="Connect Observer to the agent running on your PC." onClose={onClose}>
    <div className="pair-illustration"><span className="pair-device">O</span><span className="pair-line">··········</span><span className="pair-device"><Monitor size={26} strokeWidth={1.5} /></span></div>
    <form onSubmit={async (e) => { e.preventDefault(); if (busy) return; setBusy(true); setError(''); try { await api.pair(address, pin, lan); setPin(''); onConnected(); } catch (e) { setError(e instanceof Error ? e.message : 'Could not connect.'); } finally { setBusy(false); } }}>
      <label className="field-label" htmlFor="pc-address">PC bridge address</label>
      <input id="pc-address" autoFocus type="text" inputMode="url" autoComplete="url" placeholder="https://your-pc.example or 192.168.1.20:8787" value={address} onChange={(e) => setAddress(e.target.value)} disabled={busy} required />
      <label className="field-label" htmlFor="pc-pin">Dashboard PIN</label>
      <input id="pc-pin" type="password" inputMode="numeric" autoComplete="off" maxLength={128} placeholder="PIN shown in your PC agent console" value={pin} onChange={(e) => setPin(e.target.value)} disabled={busy} required />
      <label className="check-row"><input type="checkbox" checked={lan} onChange={(e) => setLan(e.target.checked)} /><span>Allow HTTP on a trusted private LAN/VPN.<small>HTTP is not encrypted. Prefer HTTPS; never expose the bridge publicly.</small></span></label>
      {!isNative() && <p className="info-note"><Info size={16} />Browser preview uses the configured bridge proxy, not a direct request to this address. Android connects directly.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="button primary full" type="submit" disabled={busy}>{busy ? <LoaderCircle size={18} className="spin" /> : <ArrowRight size={18} />} {busy ? 'Connecting securely…' : 'Connect my PC'}</button>
    </form><p className="trust-note"><ShieldCheck size={14} />Your PIN is never saved. Android credentials use the device Keystore.</p>
  </Modal>;
}

import { useEffect, useRef, useState } from 'react';
import { Mic, LoaderCircle, PhoneOff, ShieldCheck, Volume2 } from 'lucide-react';
import { api } from '../core/api';
import { cancelSpeech, dictate, speak } from '../core/speech';
import type { Reply } from '../types';
import { Modal, Mark } from './ui';
export default function Voice({ language, onClose, onReply }: { language: string; onClose: () => void; onReply: (r: Reply) => void }) {
  const [phase, setPhase] = useState('Ready when you are.'), [busy, setBusy] = useState(false), [error, setError] = useState(''), [last, setLast] = useState('');
  const session = useRef(''), alive = useRef(true), audio = useRef<HTMLAudioElement | null>(null), starting = useRef(false);
  useEffect(() => { alive.current = true; const hidden = () => { if (document.hidden) onClose(); }; document.addEventListener('visibilitychange', hidden); return () => { alive.current = false; cancelSpeech(); audio.current?.pause(); if (session.current) void api.post('/api/call/stop', { sessionId: session.current }).catch(() => {}); document.removeEventListener('visibilitychange', hidden); }; }, [onClose]);
  async function listen() {
    if (busy || starting.current) return; setBusy(true); setError(''); starting.current = true;
    try {
      if (!session.current) { setPhase('Starting your voice session…'); const res = await api.post<Reply & { sessionId: string }>('/api/call/start', {}); session.current = res.sessionId; if (!alive.current) { void api.post('/api/call/stop', { sessionId: res.sessionId }).catch(() => {}); return; } }
      setPhase('Listening. Say what’s on your mind.'); const text = await dictate(language);
      if (!alive.current || !text.trim()) return; setLast(text); setPhase('Your agent is working…');
      const reply = await api.post<Reply>('/api/call/say', { sessionId: session.current, text }); if (!alive.current) return;
      onReply(reply); setPhase(reply.awaitingConfirm ? 'Waiting for your explicit confirmation.' : 'A thought, out loud.'); setLast(reply.text || '');
      if (reply.audio) { audio.current = new Audio(reply.audio); await audio.current.play().catch(() => { if (reply.text) speak(reply.text, language); }); }
      else if (reply.text) speak(reply.text, language);
    } catch (e) { if (alive.current) { setError(e instanceof Error ? e.message : 'Voice unavailable'); setPhase('Let’s try that again.'); } }
    finally { starting.current = false; if (alive.current) setBusy(false); }
  }
  return <Modal title="Say it your way." subtitle="A push-to-talk conversation with your existing agent." onClose={onClose}>
    <div className="voice-space"><div className={`voice-mark ${busy ? 'working' : ''}`}><Mark size={54} /></div><h3 role="status">{phase}</h3><p>{last || 'English, Hindi, or a little of both.'}</p>{error && <p className="form-error" role="alert">{error}</p>}<button className="voice-mic" disabled={busy} onClick={() => void listen()} aria-label="Push to talk">{busy ? <LoaderCircle className="spin" size={28} /> : <Mic size={28} />}</button><small>{busy ? 'One turn at a time' : 'Tap to talk'}</small></div>
    <div className="button-row"><button className="button full" onClick={() => { cancelSpeech(); audio.current?.pause(); }}><Volume2 size={16} />Stop playback</button><button className="button full" onClick={onClose}><PhoneOff size={16} />End session</button></div><p className="trust-note"><ShieldCheck size={14} />No always-on listening. PC permissions and action confirmations still apply. Speech recognition may use your phone’s provider.</p>
  </Modal>;
}

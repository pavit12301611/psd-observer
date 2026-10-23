import { useEffect, useId, useRef, type ReactNode, type ButtonHTMLAttributes } from 'react';
import { X, Eye, ArrowUpRight } from 'lucide-react';
export function Mark({ size = 28 }: { size?: number }) { return <Eye size={size} strokeWidth={1.65} aria-hidden="true" />; }
export function IconButton({ label, children, className = '', ...props }: { label: string; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`icon-button ${className}`} title={label} aria-label={label} {...props}>{children}</button>;
}
export function Modal({ title, subtitle, children, onClose, wide = false, className = '' }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; wide?: boolean; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null), id = useId();
  useEffect(() => { const el = ref.current; el?.showModal(); return () => { el?.close(); }; }, []);
  return <dialog ref={ref} className={`modal ${wide ? 'modal-wide' : ''} ${className}`} aria-labelledby={id} onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
    <div className="modal-body"><div className="modal-heading"><div><h2 id={id}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><IconButton label="Close dialog" onClick={onClose}><X size={20} /></IconButton></div>{children}</div>
  </dialog>;
}
export function EmptyPanel({ icon, title, children, action }: { icon: ReactNode; title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty-panel"><span className="empty-icon">{icon}</span><h2>{title}</h2><p>{children}</p>{action}</div>;
}
export function SectionHeading({ eyebrow, title, children, action }: { eyebrow: string; title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="section-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{children && <p>{children}</p>}</div>{action}</div>;
}
export function SettingRow({ icon, title, description, children }: { icon: ReactNode; title: string; description?: string; children?: ReactNode }) {
  return <div className="setting-row"><span className="setting-icon">{icon}</span><div className="setting-copy"><strong>{title}</strong>{description && <span>{description}</span>}</div>{children || <ArrowUpRight size={17} className="muted" />}</div>;
}

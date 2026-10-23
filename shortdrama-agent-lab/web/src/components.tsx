import { lazy, Suspense, useEffect, useRef, type ReactNode } from 'react';
import { Aperture, ArrowUpRight, Check, Info, X } from 'lucide-react';
import SpotlightCard from './vendor/SpotlightCard';

export function Brand() {
  return <a className="brand" href="#/studio" aria-label="OHAO 创作首页"><span className="brand-symbol"><Aperture size={25} strokeWidth={1.6} /></span><strong>OHAO<span>STORY STUDIO</span></strong></a>;
}
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <SpotlightCard className={className} spotlightColor="rgba(244, 131, 84, 0.13)">{children}</SpotlightCard>;
}
export function ArrowButton({ children, onClick, secondary = false }: { children: ReactNode; onClick: () => void; secondary?: boolean }) {
  return <button className={`button ${secondary ? 'secondary' : 'primary'} arrow-button`} onClick={onClick}>{children}<ArrowUpRight size={17} /></button>;
}
export function Tag({ children, tone = '' }: { children: ReactNode; tone?: string }) {
  return <span className={`tag ${tone}`}>{children}</span>;
}
export function PageHeading({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children?: ReactNode }) {
  return <div className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="muted">{description}</p></div><div className="heading-actions">{children}</div></div>;
}
export function Notice({ children }: { children: ReactNode }) {
  return <p className="notice"><Info size={15} aria-hidden="true" /><span>{children}</span></p>;
}
export function Modal({ open, title, onClose, children, className = '' }: { open: boolean; title: string; onClose: () => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (open && !dialog?.open) dialog?.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open]);
  return <dialog ref={ref} className={`modal ${className}`} aria-label={title} onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) { const r = e.currentTarget.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose(); } }}>
    <div className="modal-heading"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={20} /></button></div>{children}
  </dialog>;
}
const DirectorPreview = lazy(() => import('./director/DirectorPreview'));
export function WhitePreview() {
  return <Suspense fallback={<p className="notice">正在准备白模画布…</p>}><DirectorPreview /></Suspense>;
}
export function Toast({ text }: { text: string }) {
  return <div className={`toast ${text ? 'show' : ''}`} role="status" aria-live="polite"><Check size={16} /><span>{text}</span></div>;
}

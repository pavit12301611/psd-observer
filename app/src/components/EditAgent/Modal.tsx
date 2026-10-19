// src/components/EditAgent/Modal.tsx
import React, { ReactNode, useEffect } from 'react';
import ReactDOM from 'react-dom';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  onRequestClose?: () => void;
  children: ReactNode;
  className?: string;      // width / height / flex etc.
  backdropClassName?: string;
}

const Modal: React.FC<ModalProps> = ({
  open,
  onClose,
  onRequestClose,
  children,
  className = '',
  backdropClassName = 'bg-black/50'
}) => {
  if (!open) return null;

  const portalTarget =
    document.getElementById('modal-root') ?? document.body;

  const handleDismiss = onRequestClose ?? onClose;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleDismiss();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleDismiss]);

  const handleBackdropMouseDown = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) handleDismiss();
  };

  return ReactDOM.createPortal(
    <div
      className={`fixed inset-0 z-[100] flex items-center justify-center ${backdropClassName}`}
      onMouseDown={handleBackdropMouseDown}
    >
      <div
        className={`relative bg-white rounded-lg shadow-xl ${className}`}
        // stop bubbling so clicks inside never reach the backdrop
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    portalTarget
  );
};

export default Modal;


import React, { useState, useRef, useEffect, ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface FixedDropdownProps {
  trigger: (props: { ref: React.RefObject<HTMLButtonElement>; onClick: () => void; isOpen: boolean }) => ReactNode;
  children: ReactNode;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  width?: number; // default 256 (w-64)
  className?: string;
}

/**
 * A dropdown that uses a portal + fixed positioning to escape overflow:hidden containers.
 * The dropdown menu appears below the trigger button and aligns to its right edge.
 */
const FixedDropdown: React.FC<FixedDropdownProps> = ({
  trigger,
  children,
  isOpen,
  onOpenChange,
  width = 256,
  className = '',
}) => {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const updatePosition = () => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setPosition({
        top: rect.bottom + 4,
        left: rect.right - width,
      });
    }
  };

  const handleToggle = () => {
    if (!isOpen) updatePosition();
    onOpenChange(!isOpen);
  };

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(event.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(event.target as Node)
      ) {
        onOpenChange(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onOpenChange]);

  // Update position on scroll/resize
  useEffect(() => {
    if (isOpen) {
      updatePosition();
      window.addEventListener('scroll', updatePosition, true);
      window.addEventListener('resize', updatePosition);
      return () => {
        window.removeEventListener('scroll', updatePosition, true);
        window.removeEventListener('resize', updatePosition);
      };
    }
  }, [isOpen]);

  const dropdownContent = isOpen && position && (
    <div
      ref={dropdownRef}
      className={`fixed bg-gray-900 bg-opacity-95 rounded shadow-lg overflow-hidden z-[100] ${className}`}
      style={{ top: position.top, left: position.left, width }}
    >
      {children}
    </div>
  );

  return (
    <>
      {trigger({ ref: buttonRef, onClick: handleToggle, isOpen })}
      {dropdownContent && createPortal(dropdownContent, document.body)}
    </>
  );
};

export default FixedDropdown;

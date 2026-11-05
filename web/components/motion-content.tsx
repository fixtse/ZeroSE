'use client';
import { motion, useAnimationControls, useReducedMotion } from 'framer-motion';
import { useEffect, type ReactNode } from 'react';
import { contentHidden, contentReveal, contentTransition } from '../lib/motion';

// Replay a reveal without remounting editors or discarding unsaved input.
export function MotionContent({
  children,
  view,
  className,
}: {
  children: ReactNode;
  view: string;
  className?: string;
}) {
  const controls = useAnimationControls();
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    if (reducedMotion) {
      controls.set(contentReveal);
      return;
    }
    controls.set(contentHidden);
    void controls.start(contentReveal, contentTransition);
    return () => controls.stop();
  }, [view, reducedMotion, controls]);
  return (
    <motion.div className={className} initial={false} animate={controls}>
      {children}
    </motion.div>
  );
}

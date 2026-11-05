'use client';
import { motion, useReducedMotion } from 'framer-motion';
import { contentHidden, contentReveal, contentTransition } from '../lib/motion';
import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from './ui/collapsible';
import { Button } from './ui/button';

const MotionCollapsibleContent = motion.create(CollapsibleContent);

export function AIEditorCard({
  id,
  kind,
  title,
  detail,
  status,
  open,
  onOpenChange,
  children,
  actions,
}: {
  id: string;
  kind: 'connection' | 'model';
  title: string;
  detail?: string;
  status: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const reducedMotion = useReducedMotion();
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      className="ai-editor-card"
      data-ai-editor={kind}
      data-editor-id={id}
    >
      <div className="ai-editor-header">
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" className="ai-editor-trigger">
            <span className="ai-editor-summary">
              <strong>{title}</strong>
              {detail && <small>{detail}</small>}
            </span>
            <span className="ai-editor-status">{status}</span>
            <ChevronDown className={open ? 'rotate-180' : undefined} aria-hidden="true" />
          </Button>
        </CollapsibleTrigger>
        <div className="action-group">{actions}</div>
      </div>
      <MotionCollapsibleContent
        forceMount
        hidden={!open}
        className="ai-editor-body"
        initial={false}
        animate={open ? contentReveal : { ...contentHidden, y: reducedMotion ? 0 : 10 }}
        transition={reducedMotion ? { duration: 0 } : contentTransition}
      >
        {children}
      </MotionCollapsibleContent>
    </Collapsible>
  );
}

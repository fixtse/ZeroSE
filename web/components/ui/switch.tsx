'use client';

import { motion, useReducedMotion } from 'framer-motion';
import { useState } from 'react';
import { Switch as SwitchPrimitive } from 'radix-ui';
import type * as React from 'react';
import { cn } from '../../lib/utils';

function Switch({
  className,
  checked,
  defaultChecked = false,
  onCheckedChange,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  const [internalChecked, setInternalChecked] = useState(defaultChecked);
  const selected = checked ?? internalChecked;
  const reducedMotion = useReducedMotion();
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input',
        className,
      )}
      {...props}
      checked={selected}
      onCheckedChange={(value) => {
        setInternalChecked(value);
        onCheckedChange?.(value);
      }}
    >
      <SwitchPrimitive.Thumb data-slot="switch-thumb" asChild>
        <motion.span
          className="pointer-events-none block size-4 rounded-full bg-white shadow-sm"
          initial={false}
          animate={{ x: selected ? 16 : 0 }}
          transition={
            reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 30 }
          }
        />
      </SwitchPrimitive.Thumb>
    </SwitchPrimitive.Root>
  );
}

export { Switch };

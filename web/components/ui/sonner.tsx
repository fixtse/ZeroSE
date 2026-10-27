'use client';
import { CircleCheck, CircleAlert, Info, LoaderCircle, TriangleAlert } from 'lucide-react';
import { Toaster as Sonner } from 'sonner';

/** Shared shadcn/Sonner host: notices stay visible independently of form scroll position. */
export function Toaster() {
  return (
    <Sonner
      theme="dark"
      position="top-right"
      closeButton
      visibleToasts={3}
      duration={5000}
      offset={{ top: 'max(16px, env(safe-area-inset-top))', right: '16px' }}
      mobileOffset={{ top: 'max(12px, env(safe-area-inset-top))', left: '12px', right: '12px' }}
      icons={{
        success: <CircleCheck className="size-4" />,
        info: <Info className="size-4" />,
        warning: <TriangleAlert className="size-4" />,
        error: <CircleAlert className="size-4" />,
        loading: <LoaderCircle className="size-4 animate-spin" />,
      }}
      toastOptions={{
        classNames: {
          toast: 'zero-toast',
          title: 'zero-toast-title',
          description: 'zero-toast-description',
          closeButton: 'zero-toast-close',
        },
      }}
    />
  );
}
